// Serves the preview: rebuilds main.tsx on every page load, so an edit to project-panel's renderer shows on reload.
// `claude-code/testing` (imported by the test worlds for their mocks) is swapped for a stub the browser can load.
import { join } from 'node:path'

const PORT = Number(process.env.PORT ?? 5178)
const here = import.meta.dir

const stubTesting: import('bun').BunPlugin = {
  name: 'stub-claude-code-testing',
  setup(build) {
    build.onResolve({ filter: /^claude-code\/testing$/ }, () => ({ path: join(here, 'stub-testing.ts') }))
  },
}

async function bundle(): Promise<Response> {
  const result = await Bun.build({ entrypoints: [join(here, 'main.tsx')], target: 'browser', plugins: [stubTesting], define: { 'process.env.NODE_ENV': '"development"' } })
  if (!result.success) return new Response(result.logs.map(String).join('\n'), { status: 500 })
  return new Response(await result.outputs[0]!.text(), { headers: { 'content-type': 'text/javascript' } })
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/main.js') return bundle()
    return new Response(Bun.file(join(here, 'index.html')))
  },
})
console.log(`pane preview on http://localhost:${PORT}`)
