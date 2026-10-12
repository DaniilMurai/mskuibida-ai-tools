import { describe, expect, test } from 'claude-code/testing'
import { hostKey, parseRemote, webBase } from '../../src/forge/remote'

describe('parseRemote: ssh', () => {
  test('scp-like git@host:group/repo.git', () => {
    expect(parseRemote('git@gitlab.example.test:acme/scanner.git')).toEqual({ host: 'gitlab.example.test', path: 'acme/scanner', scheme: 'ssh' })
  })

  test('scp-like without a user', () => {
    expect(parseRemote('gitlab.example.test:acme/scanner')).toEqual({ host: 'gitlab.example.test', path: 'acme/scanner', scheme: 'ssh' })
  })

  test('ssh:// drops the ssh port: it is not the web port', () => {
    const remote = parseRemote('ssh://git@gitlab.example.test:2222/acme/platform/scanner.git')
    expect(remote).toEqual({ host: 'gitlab.example.test', path: 'acme/platform/scanner', scheme: 'ssh' })
    expect(remote?.port).toBeUndefined()
    expect(webBase(remote as NonNullable<typeof remote>)).toBe('https://gitlab.example.test/acme/platform/scanner')
  })

  test('github.com over ssh', () => {
    expect(parseRemote('git@github.com:acme/shop.git')).toEqual({ host: 'github.com', path: 'acme/shop', scheme: 'ssh' })
  })
})

describe('parseRemote: http(s) and git', () => {
  test('https keeps the port and the web base follows it', () => {
    const remote = parseRemote('https://gitlab.example.test:8443/acme/platform/scanner.git') as NonNullable<ReturnType<typeof parseRemote>>
    expect(remote).toEqual({ host: 'gitlab.example.test', port: 8443, path: 'acme/platform/scanner', scheme: 'https' })
    expect(webBase(remote)).toBe('https://gitlab.example.test:8443/acme/platform/scanner')
    expect(hostKey(remote)).toBe('gitlab.example.test:8443')
  })

  test('credentials are stripped, user and token alike', () => {
    for (const url of [
      'https://oauth2:glpat-SECRET@gitlab.example.test/acme/scanner.git',
      'https://someone@gitlab.example.test/acme/scanner.git',
      'https://someone:p%40ss@gitlab.example.test/acme/scanner',
    ]) {
      const remote = parseRemote(url)
      expect(remote).toEqual({ host: 'gitlab.example.test', path: 'acme/scanner', scheme: 'https' })
      expect(JSON.stringify(remote)).not.toContain('SECRET')
      expect(JSON.stringify(remote)).not.toContain('someone')
    }
  })

  test('a password containing @ parses (the user info ends at the last @) and never leaks', () => {
    for (const url of ['https://user:p@ss@gitlab.example.test/acme/scanner.git', 'https://oauth2:a@b@c@gitlab.example.test:8443/acme/scanner.git', 'ssh://deploy:x@y@gitlab.example.test/acme/scanner.git']) {
      const remote = parseRemote(url)
      expect(remote?.host).toBe('gitlab.example.test')
      expect(remote?.path).toBe('acme/scanner')
      expect(Object.keys(remote as object).sort()).toEqual(expect.arrayContaining(['host', 'path', 'scheme']))
      expect(JSON.stringify(remote)).not.toMatch(/@|user|oauth2|deploy|ss"|b@c/)
    }
  })

  test('a port above 65535 (or 0) is no remote', () => {
    expect(parseRemote('https://gitlab.example.test:70000/acme/scanner.git')).toBeNull()
    expect(parseRemote('ssh://git@gitlab.example.test:65536/acme/scanner.git')).toBeNull()
    expect(parseRemote('https://gitlab.example.test:0/acme/scanner.git')).toBeNull()
    expect(parseRemote('https://gitlab.example.test:65535/acme/scanner.git')?.port).toBe(65535)
  })

  test('ssh.github.com (ssh over 443) is github.com', () => {
    expect(parseRemote('ssh://git@ssh.github.com:443/acme/shop.git')).toEqual({ host: 'github.com', path: 'acme/shop', scheme: 'ssh' })
    expect(parseRemote('git@ssh.github.com:acme/shop.git')?.host).toBe('github.com')
  })

  test('http stays http in the web base', () => {
    const remote = parseRemote('http://git.example.test:8080/acme/scanner.git') as NonNullable<ReturnType<typeof parseRemote>>
    expect(remote.scheme).toBe('http')
    expect(webBase(remote)).toBe('http://git.example.test:8080/acme/scanner')
  })

  test('git://', () => {
    expect(parseRemote('git://git.example.test/acme/scanner.git')).toEqual({ host: 'git.example.test', path: 'acme/scanner', scheme: 'git' })
  })

  test('a trailing slash, .git, or both', () => {
    for (const url of ['https://gitlab.example.test/acme/scanner/', 'https://gitlab.example.test/acme/scanner.git', 'https://gitlab.example.test/acme/scanner.git/']) {
      expect(parseRemote(url)?.path).toBe('acme/scanner')
    }
  })

  test('the host is lower-cased, the path is not', () => {
    expect(parseRemote('https://GitLab.Example.TEST/Acme/Scanner.git')).toEqual({ host: 'gitlab.example.test', path: 'Acme/Scanner', scheme: 'https' })
    expect(parseRemote('git@GitHub.com:Acme/Shop.git')?.host).toBe('github.com')
  })
})

describe('parseRemote: nested groups', () => {
  test('any depth, over every scheme', () => {
    const path = 'acme/platform/mobile/apps/scanner'
    expect(parseRemote(`git@gitlab.example.test:${path}.git`)?.path).toBe(path)
    expect(parseRemote(`ssh://git@gitlab.example.test/${path}.git`)?.path).toBe(path)
    expect(parseRemote(`https://gitlab.example.test/${path}`)?.path).toBe(path)
    expect(parseRemote(`git://gitlab.example.test/${path}.git`)?.path).toBe(path)
  })
})

describe('parseRemote: github.com', () => {
  test('https and the web base', () => {
    const remote = parseRemote('https://github.com/acme/shop.git') as NonNullable<ReturnType<typeof parseRemote>>
    expect(remote).toEqual({ host: 'github.com', path: 'acme/shop', scheme: 'https' })
    expect(webBase(remote)).toBe('https://github.com/acme/shop')
    expect(hostKey(remote)).toBe('github.com')
  })
})

describe('parseRemote: not a remote', () => {
  for (const url of [
    '',
    '   ',
    '/Users/me/code/shop',
    './shop',
    '../shop',
    '~/shop',
    'C:\\code\\shop',
    'C:/code/shop',
    'file:///Users/me/code/shop',
    'file://host/code/shop',
    'shop',
    'https://gitlab.example.test',
    'https://gitlab.example.test/onlyone',
    'git@gitlab.example.test:onlyone.git',
    'https://gitlab.example.test/acme/../etc',
  ]) {
    test(`${JSON.stringify(url)} -> null`, () => {
      expect(parseRemote(url)).toBeNull()
    })
  }
})
