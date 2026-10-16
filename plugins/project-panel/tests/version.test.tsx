import { describe, expect, test } from 'claude-code/testing'

import { tree } from '../fixtures/real-sample'
import { manifestPath, versionOfManifest } from '../src/version'
import { MOUNT, mutableCopy, serveSession } from './world'

type Found = { type?: string; text: string; props: Record<string, unknown> }
type Probe = { findAll: (query: { type?: string }) => Promise<Found[]> }

const texts = async (ui: unknown) => (await (ui as Probe).findAll({ type: 'Text' })).map(el => el.text)

describe('the version mark', () => {
  test('the manifest gives its version; anything else gives nothing', () => {
    expect(versionOfManifest('{"name":"project-panel","version":"0.14.0"}')).toBe('0.14.0')
    expect(versionOfManifest('{"version":" 1.2.3 "}')).toBe('1.2.3')
    expect(versionOfManifest(null)).toBe('')
    expect(versionOfManifest('not json')).toBe('')
    expect(versionOfManifest('{"version":3}')).toBe('')
    expect(versionOfManifest('[]')).toBe('')
    expect(versionOfManifest('null')).toBe('')
    expect(manifestPath('/plugins/project-panel/')).toBe('/plugins/project-panel/.claude-plugin/plugin.json')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the pane reads its own manifest and shows the version, dim, as its last line, on ${surface}`, async ($, on) => {
      const files = mutableCopy(tree)
      const calls = serveSession(on, { tree: files, surfaces: [surface] })
      await $.session.start({ cwd: '/work/app', surface, isInteractive: true })

      // No manifest in the tree yet: the pane draws without a mark, having asked for the one under the plugin root.
      const first = await $.ui.mount({ ...MOUNT, surface })
      const path = calls.reads.find(read => read.endsWith('/.claude-plugin/plugin.json'))
      expect(path).toBeDefined()
      expect((await texts(first)).some(text => text.startsWith('project-panel '))).toBe(false)
      await first.unmount()

      // A failed read is asked again on the next draw; this time the manifest is there.
      files.files[path!] = JSON.stringify({ name: 'project-panel', version: '9.9.9' })
      const second = await $.ui.mount({ ...MOUNT, surface })
      const shown = await texts(second)
      expect(shown.at(-1)).toBe('project-panel 9.9.9')
      const mark = (await (second as unknown as Probe).findAll({ type: 'Text' })).at(-1)
      expect(mark?.props.dimColor).toBe(true)
      await second.unmount()

      // Read once: a third draw asks for it no more.
      const asked = calls.reads.filter(read => read === path).length
      const third = await $.ui.mount({ ...MOUNT, surface })
      expect(calls.reads.filter(read => read === path).length).toBe(asked)
      await third.unmount()
    })
  }
})
