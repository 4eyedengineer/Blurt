import { describe, expect, it } from 'vitest'
import { renderManagedCommand, tokenizeCommand } from './sidecar'

describe('tokenizeCommand', () => {
  it('splits on whitespace', () => {
    expect(tokenizeCommand('litert-lm serve --port 8765')).toEqual([
      'litert-lm',
      'serve',
      '--port',
      '8765'
    ])
  })

  it('respects double-quoted segments containing spaces', () => {
    expect(tokenizeCommand('litert-lm serve --model "C:\\my models\\gemma.litertlm"')).toEqual([
      'litert-lm',
      'serve',
      '--model',
      'C:\\my models\\gemma.litertlm'
    ])
  })

  it('respects single-quoted segments', () => {
    expect(tokenizeCommand("cmd --flag 'value with spaces'")).toEqual([
      'cmd',
      '--flag',
      'value with spaces'
    ])
  })
})

describe('renderManagedCommand', () => {
  it('substitutes {modelPath} and {port} before tokenizing', () => {
    const args = renderManagedCommand('litert-lm serve --model {modelPath} --port {port}', {
      modelPath: '/models/gemma-4-e2b.litertlm',
      port: 8765
    })
    expect(args).toEqual([
      'litert-lm',
      'serve',
      '--model',
      '/models/gemma-4-e2b.litertlm',
      '--port',
      '8765'
    ])
  })

  it('substitutes a quoted {modelPath} containing spaces as one token', () => {
    const args = renderManagedCommand('litert-lm serve --model "{modelPath}" --port {port}', {
      modelPath: '/models/my model.litertlm',
      port: 9000
    })
    expect(args).toEqual([
      'litert-lm',
      'serve',
      '--model',
      '/models/my model.litertlm',
      '--port',
      '9000'
    ])
  })
})
