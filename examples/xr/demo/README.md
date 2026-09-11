# demo

A hillside of crate-stones on XR Publisher 0.2.0 terrain.

Not in the npm package. Needs `@antpb/xr-publisher` (the runtime) and a build
of the plugin in this folder.

From the audiocrate package root:

```bash
npm install
npm run example:xr
```

http://localhost:5176

Hosted: **https://crate-playground.sxpdigital.workers.dev/xr-publisher/**

The page loads the published UMD runtime, then
`crate-stones-xr-publisher-plugin.umd.js` from this example. The load overlay
uses [`assets/preview.jpg`](assets/preview.jpg). No NPC plugins, no publishing
API. Click Load World, walk to a stone, press E.
