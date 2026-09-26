import { describe, expect, it } from 'vitest'
import {
  encodeRlmRequest,
  parseRlmEvent,
  rebuildEvent,
  RLM_FRAME_SEPARATOR,
  RLM_MINIMUM_PYTHON_MAJOR,
  RLM_MINIMUM_PYTHON_MINOR,
  RLM_PROTOCOL_VERSION,
} from '../src/index.ts'

describe('protocol constants', () => {
  it('pins the version the runtime announces', () => {
    expect(RLM_PROTOCOL_VERSION).toBe(3)
    expect(RLM_MINIMUM_PYTHON_MAJOR).toBe(3)
    expect(RLM_MINIMUM_PYTHON_MINOR).toBe(10)
    expect(RLM_FRAME_SEPARATOR).toBe('\n')
  })
})

describe('encodeRlmRequest', () => {
  it('terminates one JSON object with the frame separator', () => {
    expect(encodeRlmRequest({ type: 'execute', id: '1', code: '1+1' }))
      .toBe('{"type":"execute","id":"1","code":"1+1"}\n')
  })
})

describe('parseRlmEvent', () => {
  it('drops a line that is not JSON', () => {
    expect(parseRlmEvent('not json')).toBeUndefined()
  })

  it('drops a JSON value that is not an event object', () => {
    expect(parseRlmEvent('42')).toBeUndefined()
    expect(parseRlmEvent('null')).toBeUndefined()
    expect(parseRlmEvent('"ready"')).toBeUndefined()
    expect(parseRlmEvent('{"event":"nonsense"}')).toBeUndefined()
  })

  it('rebuilds the ready handshake', () => {
    expect(parseRlmEvent('{"event":"ready","protocol":3,"python":"3.13.11"}'))
      .toEqual({ event: 'ready', protocol: 3, python: '3.13.11' })
    expect(parseRlmEvent('{"event":"ready","protocol":"3","python":"3.13.11"}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"ready","protocol":3}')).toBeUndefined()
  })

  it('rebuilds output frames with a cell id or the null attribution', () => {
    expect(parseRlmEvent('{"event":"stdout","id":"1","text":"hi"}'))
      .toEqual({ event: 'stdout', id: '1', text: 'hi' })
    expect(parseRlmEvent('{"event":"stderr","id":null,"text":"hi"}'))
      .toEqual({ event: 'stderr', id: null, text: 'hi' })
    expect(parseRlmEvent('{"event":"stdout","id":7,"text":"hi"}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"stdout","id":"1"}')).toBeUndefined()
  })

  it('rebuilds a trailing-expression result', () => {
    expect(parseRlmEvent('{"event":"result","id":"1","text":"2"}'))
      .toEqual({ event: 'result', id: '1', text: '2' })
    expect(parseRlmEvent('{"event":"result","id":null,"text":"2"}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"result","id":"1","text":7}')).toBeUndefined()
  })

  it('rebuilds a display frame only for a JSON object payload', () => {
    expect(parseRlmEvent('{"event":"display","id":"1","data":{"text/plain":"2"}}'))
      .toEqual({ event: 'display', id: '1', data: { 'text/plain': '2' } })
    expect(parseRlmEvent('{"event":"display","id":null,"data":{}}'))
      .toEqual({ event: 'display', id: null, data: {} })
    expect(parseRlmEvent('{"event":"display","id":"1","data":[1]}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"display","id":"1","data":"x"}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"display","id":"1"}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"display","id":true,"data":{}}')).toBeUndefined()
  })

  it('drops a payload whose members are not JSON values', () => {
    expect(rebuildEvent({ event: 'display', id: '1', data: { fn: () => undefined } })).toBeUndefined()
    expect(rebuildEvent({ event: 'host_request', id: 'h1', data: { nested: { deep: () => undefined } } })).toBeUndefined()
  })

  it('rebuilds a host request only for a JSON object payload', () => {
    expect(parseRlmEvent('{"event":"host_request","id":"h1","data":{"type":"model.info"}}'))
      .toEqual({ event: 'host_request', id: 'h1', data: { type: 'model.info' } })
    expect(parseRlmEvent('{"event":"host_request","id":1,"data":{}}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"host_request","id":"h1","data":"x"}')).toBeUndefined()
  })

  it('rebuilds an error frame with a string traceback', () => {
    expect(parseRlmEvent('{"event":"error","id":"1","ename":"ValueError","evalue":"bad","traceback":["a","b"]}'))
      .toEqual({ event: 'error', id: '1', ename: 'ValueError', evalue: 'bad', traceback: ['a', 'b'] })
    expect(parseRlmEvent('{"event":"error","id":null,"ename":"E","evalue":"v","traceback":[]}'))
      .toEqual({ event: 'error', id: null, ename: 'E', evalue: 'v', traceback: [] })
    expect(parseRlmEvent('{"event":"error","id":"1","ename":"E","evalue":"v","traceback":"x"}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"error","id":"1","ename":"E","evalue":"v","traceback":[1]}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"error","id":"1","ename":1,"evalue":"v","traceback":[]}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"error","id":"1","ename":"E","evalue":"v"}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"error","id":{},"ename":"E","evalue":"v","traceback":[]}')).toBeUndefined()
  })

  it('rebuilds a done frame with its request-type extras', () => {
    expect(parseRlmEvent('{"event":"done","id":"1","status":"ok"}'))
      .toEqual({ event: 'done', id: '1', status: 'ok' })
    expect(parseRlmEvent('{"event":"done","id":"1","status":"error","reason":"dill unavailable"}'))
      .toEqual({ event: 'done', id: '1', status: 'error', reason: 'dill unavailable' })
    expect(parseRlmEvent('{"event":"done","id":"1","status":"ok","saved":["a"],"skipped":["b"],"pruned":["c"],"bytes":49}'))
      .toEqual({ event: 'done', id: '1', status: 'ok', saved: ['a'], skipped: ['b'], pruned: ['c'], bytes: 49 })
    expect(parseRlmEvent('{"event":"done","id":"1","status":"ok","restored":["a"],"failed":["b"]}'))
      .toEqual({ event: 'done', id: '1', status: 'ok', restored: ['a'], failed: ['b'] })
    expect(parseRlmEvent('{"event":"done","id":"1","status":"ok","names":["a"]}'))
      .toEqual({ event: 'done', id: '1', status: 'ok', names: ['a'] })
    expect(parseRlmEvent('{"event":"done","id":1,"status":"ok"}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"done","id":"1","status":"maybe"}')).toBeUndefined()
    expect(parseRlmEvent('{"event":"done","id":"1","status":"ok","reason":7}'))
      .toEqual({ event: 'done', id: '1', status: 'ok' })
    expect(parseRlmEvent('{"event":"done","id":"1","status":"ok","names":"a"}'))
      .toEqual({ event: 'done', id: '1', status: 'ok' })
    expect(parseRlmEvent('{"event":"done","id":"1","status":"ok","names":[1]}'))
      .toEqual({ event: 'done', id: '1', status: 'ok' })
    expect(parseRlmEvent('{"event":"done","id":"1","status":"ok","bytes":"49"}'))
      .toEqual({ event: 'done', id: '1', status: 'ok' })
  })
})

describe('rebuildEvent', () => {
  it('rejects non-object frames', () => {
    expect(rebuildEvent(undefined)).toBeUndefined()
    expect(rebuildEvent(null)).toBeUndefined()
  })
})
