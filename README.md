# osky

A small, personal Bluesky client built on AT Protocol.

The first version supports OAuth sign-in, a desktop navigation rail with an infinitely scrolling feed and search/trending sidebar, smart inline reply previews and full conversations, Bluesky-style quote-post cards, inline image galleries and video, account autocomplete, account and skeet search, internal profile pages, refresh, and sign-out.

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
