// What the test worlds take from `claude-code/testing`, enough for their model builders to load in a browser.
export const mock = new Proxy({}, { get: () => () => undefined })
export const describe = () => undefined
export const test = () => undefined
export const expect = () => undefined
