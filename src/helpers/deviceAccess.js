// @flow
import type Transport from '@ledgerhq/hw-transport'
import TransportNodeHid from '@ledgerhq/hw-transport-node-hid'
import { DEBUG_DEVICE } from 'config/constants'
import { retry } from './promise'
import { createCustomErrorClass } from './errors'

// all open to device must use openDevice so we can prevent race conditions
// and guarantee we do one device access at a time. It also will handle the .close()
// NOTE optim: in the future we can debounce the close & reuse the same transport instance.

type WithDevice = (devicePath: string) => <T>(job: (Transport<*>) => Promise<*>) => Promise<T>

const DisconnectedDevice = createCustomErrorClass('DisconnectedDevice')

const mapError = e => {
  if (e && e.message && e.message.indexOf('HID') >= 0) {
    throw new DisconnectedDevice(e.message)
  }
  throw e
}

let queue = Promise.resolve()

let busy = false

TransportNodeHid.setListenDevicesPollingSkip(() => busy)

export const withDevice: WithDevice = devicePath => job => {
  const p = queue.then(async () => {
    busy = true
    try {
      const t = await retry(() => TransportNodeHid.open(devicePath), { maxRetry: 1 })
      if (DEBUG_DEVICE) {
        t.setDebugMode(true)
      }
      try {
        const res = await job(t).catch(mapError)
        return res
      } finally {
        await t.close()
      }
    } finally {
      busy = false
    }
  })

  queue = p.catch(() => null)

  return p
}
