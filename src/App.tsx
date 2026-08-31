import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Agent, AppBskyFeedDefs, AppBskyFeedPost } from '@atproto/api'
import { BrowserOAuthClient } from '@atproto/oauth-client-browser'

const SCOPE =
  'atproto rpc:app.bsky.feed.getTimeline?aud=did:web:api.bsky.app#bsky_appview'

function clientId() {
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname)

  if (isLocal) {
    const redirectUri = new URL(window.location.origin)
    redirectUri.hostname = '127.0.0.1'
    redirectUri.pathname = '/'

    return `http://localhost?${new URLSearchParams({
      scope: SCOPE,
      redirect_uri: redirectUri.href,
    })}`
  }

  return `${window.location.origin}/osky/oauth-client-metadata.json`
}

function postUrl(post: AppBskyFeedDefs.PostView) {
  const rkey = post.uri.split('/').at(-1)
  return `https://bsky.app/profile/${post.author.handle}/post/${rkey}`
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function FeedPost({ item }: { item: AppBskyFeedDefs.FeedViewPost }) {
  const record = AppBskyFeedPost.isRecord(item.post.record)
    ? item.post.record
    : null
  const repost = AppBskyFeedDefs.isReasonRepost(item.reason)
    ? item.reason.by
    : null

  return (
    <article className="post">
      {repost && (
        <p className="repost">Reposted by @{repost.handle}</p>
      )}
      <div className="post-grid">
        {item.post.author.avatar ? (
          <img
            className="avatar"
            src={item.post.author.avatar}
            alt=""
            width="48"
            height="48"
          />
        ) : (
          <div className="avatar avatar-fallback" aria-hidden="true">
            {item.post.author.handle.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="post-body">
          <div className="author-line">
            <strong>{item.post.author.displayName || item.post.author.handle}</strong>
            <span>@{item.post.author.handle}</span>
          </div>
          {record && typeof record.text === 'string' ? (
            <p className="post-text">{record.text}</p>
          ) : (
            <p className="post-text unavailable">Unsupported post format</p>
          )}
          <a
            className="post-meta"
            href={postUrl(item.post)}
            target="_blank"
            rel="noreferrer"
          >
            {formatDate(item.post.indexedAt)} · {item.post.replyCount ?? 0} replies ·{' '}
            {item.post.repostCount ?? 0} reposts · {item.post.likeCount ?? 0} likes
          </a>
        </div>
      </div>
    </article>
  )
}

export default function App() {
  const oauthRef = useRef<BrowserOAuthClient | null>(null)
  const agentRef = useRef<Agent | null>(null)
  const didRef = useRef<string | null>(null)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const loadingRef = useRef(false)
  const [status, setStatus] = useState<'starting' | 'signed-out' | 'signed-in'>('starting')
  const [handle, setHandle] = useState('')
  const [signedInHandle, setSignedInHandle] = useState('')
  const [feed, setFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const loadFeed = useCallback(async (nextCursor?: string, append = false) => {
    const agent = agentRef.current
    if (!agent || loadingRef.current) return

    loadingRef.current = true
    setBusy(true)
    setLoadingMore(append)
    setError('')
    try {
      const response = await agent.app.bsky.feed.getTimeline({
        limit: 30,
        cursor: nextCursor,
      })
      setFeed((current) =>
        append ? [...current, ...response.data.feed] : response.data.feed,
      )
      setCursor(response.data.cursor)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load your feed.')
    } finally {
      loadingRef.current = false
      setBusy(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => {
    const sentinel = loadMoreRef.current
    if (status !== 'signed-in' || !cursor || !sentinel) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        observer.unobserve(sentinel)
        void loadFeed(cursor, true)
      },
      { rootMargin: '600px 0px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [cursor, loadFeed, status])

  useEffect(() => {
    let cancelled = false

    async function initialize() {
      try {
        const oauth = await BrowserOAuthClient.load({
          clientId: clientId(),
          handleResolver: 'https://bsky.social',
        })
        oauthRef.current = oauth

        const result = await oauth.init()
        if (cancelled) return

        if (!result) {
          setStatus('signed-out')
          return
        }

        const agent = new Agent(result.session)
        agentRef.current = agent
        didRef.current = result.session.did
        const session = await agent.com.atproto.server.getSession()
        if (cancelled) return

        setSignedInHandle(session.data.handle)
        setStatus('signed-in')
        await loadFeed()
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not start osky.')
          setStatus('signed-out')
        }
      }
    }

    void initialize()
    return () => {
      cancelled = true
    }
  }, [loadFeed])

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!oauthRef.current || !handle.trim()) return

    setBusy(true)
    setError('')
    try {
      await oauthRef.current.signIn(handle.trim(), {
        state: crypto.randomUUID(),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.')
      setBusy(false)
    }
  }

  async function signOut() {
    if (!oauthRef.current || !didRef.current) return

    setBusy(true)
    setError('')
    try {
      await oauthRef.current.revoke(didRef.current)
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-out failed.')
      setBusy(false)
    }
  }

  return (
    <main className="shell">
      <header className="masthead">
        <a className="wordmark" href={import.meta.env.BASE_URL} aria-label="osky home">
          <span className="mark">o</span>sky
        </a>
        {status === 'signed-in' && (
          <div className="account">
            <span>@{signedInHandle}</span>
            <button className="text-button" onClick={signOut} disabled={busy}>
              Sign out
            </button>
          </div>
        )}
      </header>

      {status === 'starting' && (
        <section className="center-card" aria-live="polite">
          <div className="spinner" />
          <p>Opening osky…</p>
        </section>
      )}

      {status === 'signed-out' && (
        <section className="login-card">
          <p className="eyebrow">A quieter way into Bluesky</p>
          <h1>Your feed, with room to make it yours.</h1>
          <p className="intro">
            osky is an experimental personal Bluesky client. Sign in through your
            AT Protocol provider; osky never sees your password.
          </p>
          <form className="login-form" onSubmit={signIn}>
            <label htmlFor="handle">Bluesky handle</label>
            <div className="input-row">
              <input
                id="handle"
                name="handle"
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                placeholder="you.bsky.social"
                autoCapitalize="none"
                autoCorrect="off"
                required
              />
              <button type="submit" disabled={busy || !handle.trim()}>
                {busy ? 'Connecting…' : 'Sign in'}
              </button>
            </div>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      )}

      {status === 'signed-in' && (
        <section className="timeline">
          <div className="feed-heading">
            <div>
              <p className="eyebrow">Home</p>
              <h1>Your feed</h1>
            </div>
            <button
              className="secondary-button"
              onClick={() => loadFeed()}
              disabled={busy}
            >
              Refresh
            </button>
          </div>

          {error && <p className="error feed-error">{error}</p>}
          <div className="feed" aria-live="polite">
            {feed.map((item, index) => (
              <FeedPost key={`${item.post.uri}-${index}`} item={item} />
            ))}
          </div>

          {cursor && (
            <div ref={loadMoreRef} className="feed-sentinel" aria-live="polite">
              {loadingMore && (
                <>
                  <div className="spinner spinner-small" />
                  <span>Loading more posts…</span>
                </>
              )}
            </div>
          )}
          {!cursor && feed.length > 0 && !busy && (
            <p className="feed-end">You’re all caught up.</p>
          )}
        </section>
      )}
    </main>
  )
}
