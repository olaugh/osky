# osky

A small, personal Bluesky client built on AT Protocol.

The first version supports OAuth sign-in, a home feed, pagination, refresh, and sign-out.

## Run locally

Requires Node.js 22 or newer.

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:5173>, enter your Bluesky handle, and approve the OAuth request on your account's provider.

## Build

```sh
npm run build
```

osky does not collect your Bluesky password. OAuth session data stays in your browser.
