// @flow

import logger from 'logger'
import Btc from '@ledgerhq/hw-app-btc'
import { withDevice } from 'helpers/deviceAccess'
import { getCryptoCurrencyById } from '@ledgerhq/live-common/lib/helpers/currencies'
import { SHOW_LEGACY_NEW_ACCOUNT } from 'config/constants'

import type { AccountRaw, OperationRaw, OperationType } from '@ledgerhq/live-common/lib/types'
import type { NJSAccount, NJSOperation } from '@ledgerhq/ledger-core/src/ledgercore_doc'

import { isSegwitAccount, isUnsplitAccount } from 'helpers/bip32'
import * as accountIdHelper from 'helpers/accountId'
import { createCustomErrorClass, deserializeError } from './errors'
import { getAccountPlaceholderName, getNewAccountPlaceholderName } from './accountName'

const NoAddressesFound = createCustomErrorClass('NoAddressesFound')

// TODO: put that info inside currency itself
const SPLITTED_CURRENCIES = {
  bitcoin_cash: {
    coinType: 0,
  },
  bitcoin_gold: {
    coinType: 0,
  },
}

export function isValidAddress(core: *, currency: *, address: string): boolean {
  const addr = new core.NJSAddress(address, currency)
  return addr.isValid(address, currency)
}

type Props = {
  core: *,
  devicePath: string,
  currencyId: string,
  onAccountScanned: AccountRaw => void,
}

export function scanAccountsOnDevice(props: Props): Promise<AccountRaw[]> {
  const { devicePath, currencyId, onAccountScanned, core } = props
  const currency = getCryptoCurrencyById(currencyId)

  return withDevice(devicePath)(async transport => {
    const hwApp = new Btc(transport)

    const commonParams = {
      core,
      currencyId,
      onAccountScanned,
      hwApp,
    }

    let allAccounts = []

    const nonSegwitAccounts = await scanAccountsOnDeviceBySegwit({
      ...commonParams,
      showNewAccount: !!SHOW_LEGACY_NEW_ACCOUNT || !currency.supportsSegwit,
      isSegwit: false,
      isUnsplit: false,
    })
    allAccounts = allAccounts.concat(nonSegwitAccounts)

    if (currency.supportsSegwit) {
      const segwitAccounts = await scanAccountsOnDeviceBySegwit({
        ...commonParams,
        showNewAccount: true,
        isSegwit: true,
        isUnsplit: false,
      })
      allAccounts = allAccounts.concat(segwitAccounts)
    }

    // TODO: put that info inside currency itself
    if (currencyId in SPLITTED_CURRENCIES) {
      const splittedAccounts = await scanAccountsOnDeviceBySegwit({
        ...commonParams,
        isSegwit: false,
        showNewAccount: false,
        isUnsplit: true,
      })
      allAccounts = allAccounts.concat(splittedAccounts)

      if (currency.supportsSegwit) {
        const segwitAccounts = await scanAccountsOnDeviceBySegwit({
          ...commonParams,
          showNewAccount: false,
          isUnsplit: true,
          isSegwit: true,
        })
        allAccounts = allAccounts.concat(segwitAccounts)
      }
    }

    return allAccounts
  })
}

function encodeWalletName({
  publicKey,
  currencyId,
  isSegwit,
  isUnsplit,
}: {
  publicKey: string,
  currencyId: string,
  isSegwit: boolean,
  isUnsplit: boolean,
}) {
  const splitConfig = isUnsplit ? SPLITTED_CURRENCIES[currencyId] || null : null
  return `${publicKey}__${currencyId}${isSegwit ? '_segwit' : ''}${splitConfig ? '_unsplit' : ''}`
}

async function scanAccountsOnDeviceBySegwit({
  core,
  hwApp,
  currencyId,
  onAccountScanned,
  isSegwit,
  isUnsplit,
  showNewAccount,
}: {
  core: *,
  hwApp: Object,
  currencyId: string,
  onAccountScanned: AccountRaw => void,
  isSegwit: boolean, // FIXME all segwit to change to 'purpose'
  showNewAccount: boolean,
  isUnsplit: boolean,
}): Promise<AccountRaw[]> {
  const customOpts =
    isUnsplit && SPLITTED_CURRENCIES[currencyId] ? SPLITTED_CURRENCIES[currencyId] : null
  const { coinType } = customOpts ? customOpts.coinType : getCryptoCurrencyById(currencyId)

  const path = `${isSegwit ? '49' : '44'}'/${coinType}'`

  const { publicKey } = await hwApp.getWalletPublicKey(path, false, isSegwit)

  const walletName = encodeWalletName({ publicKey, currencyId, isSegwit, isUnsplit })

  // retrieve or create the wallet
  const wallet = await getOrCreateWallet(core, walletName, currencyId, isSegwit, isUnsplit)
  const accountsCount = await wallet.getAccountCount()

  // recursively scan all accounts on device on the given app
  // new accounts will be created in sqlite, existing ones will be updated
  const accounts = await scanNextAccount({
    core,
    wallet,
    hwApp,
    currencyId,
    accountsCount,
    accountIndex: 0,
    accounts: [],
    onAccountScanned,
    isSegwit,
    isUnsplit,
    showNewAccount,
  })

  return accounts
}

const hexToBytes = str => Array.from(Buffer.from(str, 'hex'))

const createAccount = async (wallet, hwApp) => {
  const accountCreationInfos = await wallet.getNextAccountCreationInfo()
  await accountCreationInfos.derivations.reduce(
    (promise, derivation) =>
      promise.then(async () => {
        const { publicKey, chainCode } = await hwApp.getWalletPublicKey(derivation)
        accountCreationInfos.publicKeys.push(hexToBytes(publicKey))
        accountCreationInfos.chainCodes.push(hexToBytes(chainCode))
      }),
    Promise.resolve(),
  )
  return wallet.newAccountWithInfo(accountCreationInfos)
}

function createEventReceiver(core, cb) {
  return new core.NJSEventReceiver({
    onEvent: event => cb(event),
  })
}

function subscribeToEventBus(core, eventBus, receiver) {
  eventBus.subscribe(core.getSerialExecutionContext('main'), receiver)
}

const coreSyncAccount = (core, account) =>
  new Promise((resolve, reject) => {
    const eventReceiver = createEventReceiver(core, e => {
      const code = e.getCode()
      if (code === core.EVENT_CODE.UNDEFINED || code === core.EVENT_CODE.SYNCHRONIZATION_FAILED) {
        const payload = e.getPayload()
        const message = (
          (payload && payload.getString('EV_SYNC_ERROR_MESSAGE')) ||
          'Sync failed'
        ).replace(' (EC_PRIV_KEY_INVALID_FORMAT)', '')
        try {
          reject(deserializeError(JSON.parse(message)))
        } catch (e) {
          reject(message)
        }
        return
      }
      if (
        code === core.EVENT_CODE.SYNCHRONIZATION_SUCCEED ||
        code === core.EVENT_CODE.SYNCHRONIZATION_SUCCEED_ON_PREVIOUSLY_EMPTY_ACCOUNT
      ) {
        resolve(() => {
          eventBus.unsubscribe(eventReceiver)
        })
      }
    })
    const eventBus = account.synchronize()
    subscribeToEventBus(core, eventBus, eventReceiver)
  })

async function scanNextAccount(props: {
  // $FlowFixMe
  wallet: NJSWallet,
  core: *,
  hwApp: Object,
  currencyId: string,
  accountsCount: number,
  accountIndex: number,
  accounts: AccountRaw[],
  onAccountScanned: AccountRaw => void,
  isSegwit: boolean,
  isUnsplit: boolean,
  showNewAccount: boolean,
}): Promise<AccountRaw[]> {
  const {
    core,
    wallet,
    hwApp,
    currencyId,
    accountsCount,
    accountIndex,
    accounts,
    onAccountScanned,
    isSegwit,
    isUnsplit,
    showNewAccount,
  } = props

  // create account only if account has not been scanned yet
  // if it has already been created, we just need to get it, and sync it
  const hasBeenScanned = accountIndex < accountsCount

  const njsAccount = hasBeenScanned
    ? await wallet.getAccount(accountIndex)
    : await createAccount(wallet, hwApp)

  const shouldSyncAccount = true // TODO: let's sync everytime. maybe in the future we can optimize.
  if (shouldSyncAccount) {
    await coreSyncAccount(core, njsAccount)
  }

  const query = njsAccount.queryOperations()
  const ops = await query.complete().execute()

  const account = await buildAccountRaw({
    njsAccount,
    isSegwit,
    isUnsplit,
    accountIndex,
    wallet,
    currencyId,
    core,
    ops,
  })

  const isEmpty = ops.length === 0

  if (!isEmpty || showNewAccount) {
    onAccountScanned(account)
    accounts.push(account)
  }

  // returns if the current index points on an account with no ops
  if (isEmpty) {
    return accounts
  }

  return scanNextAccount({ ...props, accountIndex: accountIndex + 1 })
}

const createWalletConfig = (core, configMap = {}) => {
  const config = new core.NJSDynamicObject()
  for (const i in configMap) {
    if (configMap.hasOwnProperty(i)) {
      config.putString(i, configMap[i])
    }
  }
  return config
}

async function getOrCreateWallet(
  core: *,
  WALLET_IDENTIFIER: string,
  currencyId: string,
  isSegwit: boolean,
  isUnsplit: boolean,
): NJSWallet {
  const pool = core.getPoolInstance()
  try {
    const wallet = await pool.getWallet(WALLET_IDENTIFIER)
    return wallet
  } catch (err) {
    const currency = await pool.getCurrency(currencyId)
    const splitConfig = isUnsplit ? SPLITTED_CURRENCIES[currencyId] || null : null
    const coinType = splitConfig ? splitConfig.coinType : '<coin_type>'
    const walletConfig = isSegwit
      ? {
          KEYCHAIN_ENGINE: 'BIP49_P2SH',
          KEYCHAIN_DERIVATION_SCHEME: `49'/${coinType}'/<account>'/<node>/<address>`,
        }
      : splitConfig
        ? {
            KEYCHAIN_DERIVATION_SCHEME: `44'/${coinType}'/<account>'/<node>/<address>`,
          }
        : undefined
    const njsWalletConfig = createWalletConfig(core, walletConfig)
    const wallet = await core
      .getPoolInstance()
      .createWallet(WALLET_IDENTIFIER, currency, njsWalletConfig)
    return wallet
  }
}

async function buildAccountRaw({
  njsAccount,
  isSegwit,
  isUnsplit,
  wallet,
  currencyId,
  core,
  accountIndex,
  ops,
}: {
  njsAccount: NJSAccount,
  isSegwit: boolean,
  isUnsplit: boolean,
  wallet: NJSWallet,
  currencyId: string,
  accountIndex: number,
  core: *,
  ops: NJSOperation[],
}): Promise<AccountRaw> {
  const njsBalance = await njsAccount.getBalance()
  const balance = njsBalance.toLong()

  const jsCurrency = getCryptoCurrencyById(currencyId)
  const { derivations } = await wallet.getAccountCreationInfo(accountIndex)
  const [walletPath, accountPath] = derivations

  // retrieve xpub
  const xpub = njsAccount.getRestoreKey()

  // blockHeight
  const { height: blockHeight } = await njsAccount.getLastBlock()

  // get a bunch of fresh addresses
  const rawAddresses = await njsAccount.getFreshPublicAddresses()

  const addresses = rawAddresses.map(njsAddress => ({
    str: njsAddress.toString(),
    path: `${accountPath}/${njsAddress.getDerivationPath()}`,
  }))

  if (addresses.length === 0) {
    throw new NoAddressesFound()
  }

  const { str: freshAddress, path: freshAddressPath } = addresses[0]

  ops.sort((a, b) => b.getDate() - a.getDate())

  const operations = ops.map(op => buildOperationRaw({ core, op, xpub }))
  const currency = getCryptoCurrencyById(currencyId)

  const name =
    operations.length === 0
      ? getNewAccountPlaceholderName(currency, accountIndex)
      : getAccountPlaceholderName(
          currency,
          accountIndex,
          (currency.supportsSegwit && !isSegwit) || false,
          isUnsplit,
        )

  const rawAccount: AccountRaw = {
    id: accountIdHelper.encode({
      type: 'libcore',
      version: '1',
      xpub,
      walletName: wallet.getName(),
    }),
    xpub,
    path: walletPath,
    name,
    isSegwit,
    freshAddress,
    freshAddressPath,
    balance,
    blockHeight,
    archived: false,
    index: accountIndex,
    operations,
    pendingOperations: [],
    currencyId,
    unitMagnitude: jsCurrency.units[0].magnitude,
    lastSyncDate: new Date().toISOString(),
  }

  return rawAccount
}

function buildOperationRaw({
  core,
  op,
  xpub,
}: {
  core: *,
  op: NJSOperation,
  xpub: string,
}): OperationRaw {
  const bitcoinLikeOperation = op.asBitcoinLikeOperation()
  const bitcoinLikeTransaction = bitcoinLikeOperation.getTransaction()
  const hash = bitcoinLikeTransaction.getHash()
  const operationType = op.getOperationType()
  let value = op.getAmount().toLong()
  const fee = op.getFees().toLong()

  const OperationTypeMap: { [_: $Keys<typeof core.OPERATION_TYPES>]: OperationType } = {
    [core.OPERATION_TYPES.SEND]: 'OUT',
    [core.OPERATION_TYPES.RECEIVE]: 'IN',
  }

  // if transaction is a send, amount becomes negative
  const type = OperationTypeMap[operationType]

  if (type === 'OUT') {
    value += fee
  }

  const id = `${xpub}-${hash}-${type}`

  return {
    id,
    hash,
    type,
    value,
    fee,
    senders: op.getSenders(),
    recipients: op.getRecipients(),
    blockHeight: op.getBlockHeight(),
    blockHash: null,
    accountId: xpub, // FIXME accountId: xpub  !?
    date: op.getDate().toISOString(),
  }
}

export async function syncAccount({ rawAccount, core }: { core: *, rawAccount: AccountRaw }) {
  const decodedAccountId = accountIdHelper.decode(rawAccount.id)
  const isSegwit = isSegwitAccount(rawAccount)
  const isUnsplit = isUnsplitAccount(rawAccount, SPLITTED_CURRENCIES[rawAccount.currencyId])
  let njsWallet
  try {
    njsWallet = await core.getPoolInstance().getWallet(decodedAccountId.walletName)
  } catch (e) {
    logger.warn(`Have to reimport the account... (${e})`)
    njsWallet = await getOrCreateWallet(
      core,
      decodedAccountId.walletName,
      rawAccount.currencyId,
      isSegwit,
      isUnsplit,
    )
  }

  let njsAccount
  try {
    njsAccount = await njsWallet.getAccount(rawAccount.index)
  } catch (e) {
    logger.warn(`Have to recreate the account... (${e.message})`)
    const extendedInfos = await njsWallet.getExtendedKeyAccountCreationInfo(rawAccount.index)
    extendedInfos.extendedKeys.push(decodedAccountId.xpub)
    njsAccount = await njsWallet.newAccountWithExtendedKeyInfo(extendedInfos)
  }

  const unsub = await coreSyncAccount(core, njsAccount)
  unsub()

  const query = njsAccount.queryOperations()
  const ops = await query.complete().execute()
  const njsBalance = await njsAccount.getBalance()

  const syncedRawAccount = await buildAccountRaw({
    njsAccount,
    isSegwit,
    isUnsplit,
    accountIndex: rawAccount.index,
    wallet: njsWallet,
    currencyId: rawAccount.currencyId,
    core,
    ops,
  })

  syncedRawAccount.balance = njsBalance.toLong()

  logger.log(`Synced account [${syncedRawAccount.name}]: ${syncedRawAccount.balance}`)

  return syncedRawAccount
}
