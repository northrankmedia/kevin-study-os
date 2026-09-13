import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { uploadFileDirectly } from './directUpload.js'

// No jsdom in this project's vitest setup (see api.test.js's own
// `global.fetch` mocking convention for the same reason) -- XMLHttpRequest is
// faked here the same way, just shaped closely enough to the real browser
// API for uploadFileDirectly's usage of it (open/setRequestHeader/upload
// .onprogress/onload/onerror/send/status).

class FakeXMLHttpRequest {
  constructor() {
    this.upload = {}
    this.requestHeaders = {}
  }

  open(method, url) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name, value) {
    this.requestHeaders[name] = value
  }

  send(body) {
    this.sentBody = body
    FakeXMLHttpRequest.instances.push(this)
  }
}

function mockFile() {
  return { name: 'memo.m4a', type: 'audio/x-m4a', size: 2048 }
}

describe('uploadFileDirectly', () => {
  beforeEach(() => {
    FakeXMLHttpRequest.instances = []
    global.XMLHttpRequest = FakeXMLHttpRequest
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete global.XMLHttpRequest
  })

  it('PUTs the file to the signed URL with the file mimetype as Content-Type', async () => {
    const promise = uploadFileDirectly('https://storage.example.com/signed?token=abc', mockFile())
    const xhr = FakeXMLHttpRequest.instances[0]

    expect(xhr.method).toBe('PUT')
    expect(xhr.url).toBe('https://storage.example.com/signed?token=abc')
    expect(xhr.requestHeaders['Content-Type']).toBe('audio/x-m4a')
    expect(xhr.requestHeaders['x-upsert']).toBe('false')

    xhr.status = 200
    xhr.onload()

    await expect(promise).resolves.toBeUndefined()
  })

  it('resolves for any 2xx status', async () => {
    const promise = uploadFileDirectly('https://storage.example.com/signed', mockFile())
    const xhr = FakeXMLHttpRequest.instances[0]
    xhr.status = 204
    xhr.onload()
    await expect(promise).resolves.toBeUndefined()
  })

  it('rejects with the status code when the storage server returns a non-2xx response', async () => {
    const promise = uploadFileDirectly('https://storage.example.com/signed', mockFile())
    const xhr = FakeXMLHttpRequest.instances[0]
    xhr.status = 403
    xhr.onload()
    await expect(promise).rejects.toThrow('403')
  })

  it('rejects with a network-error message on xhr.onerror', async () => {
    const promise = uploadFileDirectly('https://storage.example.com/signed', mockFile())
    const xhr = FakeXMLHttpRequest.instances[0]
    xhr.onerror()
    await expect(promise).rejects.toThrow(/connection/)
  })

  it('reports fractional progress via onProgress when the event is length-computable', async () => {
    const onProgress = vi.fn()
    const promise = uploadFileDirectly('https://storage.example.com/signed', mockFile(), onProgress)
    const xhr = FakeXMLHttpRequest.instances[0]

    xhr.upload.onprogress({ lengthComputable: true, loaded: 512, total: 2048 })
    expect(onProgress).toHaveBeenCalledWith(0.25)

    xhr.upload.onprogress({ lengthComputable: false, loaded: 1024, total: 2048 })
    expect(onProgress).toHaveBeenCalledTimes(1)

    xhr.status = 200
    xhr.onload()
    await promise
  })
})
