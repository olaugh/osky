import { FormEvent, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  Agent,
  AppBskyActorDefs,
  AppBskyEmbedGallery,
  AppBskyEmbedImages,
  AppBskyEmbedRecord,
  AppBskyEmbedRecordWithMedia,
  AppBskyEmbedVideo,
  AppBskyFeedDefs,
  AppBskyFeedPost,
  AppBskyGraphDefs,
  AppBskyUnspeccedDefs,
} from '@atproto/api'
import { BrowserOAuthClient } from '@atproto/oauth-client-browser'
import type HlsPlayer from 'hls.js'

const APPVIEW_AUDIENCE = 'did:web:api.bsky.app#bsky_appview'
const SEARCH_SCOPES = [
  `rpc:app.bsky.actor.searchActors?aud=${APPVIEW_AUDIENCE}`,
  `rpc:app.bsky.feed.searchPosts?aud=${APPVIEW_AUDIENCE}`,
]
const GRAPH_SCOPES = [
  'repo:app.bsky.graph.block',
  'repo:app.bsky.graph.follow',
  `rpc:app.bsky.graph.muteActor?aud=${APPVIEW_AUDIENCE}`,
  `rpc:app.bsky.graph.unmuteActor?aud=${APPVIEW_AUDIENCE}`,
]
const SCOPE = [
  'atproto',
  `rpc:app.bsky.feed.getTimeline?aud=${APPVIEW_AUDIENCE}`,
  ...SEARCH_SCOPES,
  ...GRAPH_SCOPES,
].join(' ')
const publicAgent = new Agent('https://public.api.bsky.app')

type ProfileFeedMode = 'posts' | 'replies' | 'both'
type EngagementKind = 'reposts' | 'likes'
type OpenEngagement = (kind: EngagementKind, post: AppBskyFeedDefs.PostView) => void
type BulkBlockResult = {
  blockedDids: string[]
  failedDids: string[]
}

const EngagementContext = createContext<OpenEngagement | null>(null)

async function getRelationships(actor: string, others: string[]) {
  const relationships = new Map<string, AppBskyGraphDefs.Relationship>()
  for (let index = 0; index < others.length; index += 30) {
    const response = await publicAgent.app.bsky.graph.getRelationships({
      actor,
      others: others.slice(index, index + 30),
    })
    for (const relationship of response.data.relationships) {
      if (AppBskyGraphDefs.isRelationship(relationship)) {
        relationships.set(relationship.did, relationship)
      }
    }
  }
  return relationships
}

function profileHref(actor: string) {
  return `#/profile/${encodeURIComponent(actor)}`
}

function profileActorFromHash() {
  const match = window.location.hash.match(/^#\/profile\/(.+)$/)
  if (!match) return null

  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

function settingsFromHash() {
  return window.location.hash === '#/settings'
}

function isDpopKeyBindingError(message: string) {
  return message.toLowerCase().includes('invalid dpop key binding')
}

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

function formatCount(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

function formatQuoteDate(value: string) {
  const date = new Date(value)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' as const }),
  }).format(date)
}

function UpArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 20V5m-6 6 6-6 6 6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
    </svg>
  )
}

type MediaImage = {
  thumb: string
  fullsize: string
  alt: string
  aspectRatio?: { width: number; height: number }
}

function AltBadge({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <button
      type="button"
      className={`alt-badge${expanded ? ' alt-badge-expanded' : ''}`}
      aria-expanded={expanded}
      aria-label={expanded ? 'Hide alt text' : 'Show alt text'}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setExpanded((current) => !current)
      }}
    >
      <span className="alt-label">ALT</span>
      <span className="alt-text">{text}</span>
    </button>
  )
}

function ImageGallery({ images }: { images: MediaImage[] }) {
  if (images.length === 0) return null

  return (
    <div className={`media-grid media-count-${Math.min(images.length, 5)}`}>
      {images.map((image, index) => (
        <div
          key={`${image.fullsize}-${index}`}
          className="media-item"
          style={
            images.length === 1 && image.aspectRatio
              ? { aspectRatio: `${image.aspectRatio.width} / ${image.aspectRatio.height}` }
              : undefined
          }
        >
          <a
            className="media-link"
            href={image.fullsize}
            target="_blank"
            rel="noreferrer"
            aria-label={image.alt ? `Open image: ${image.alt}` : 'Open image'}
          >
            <img
              className="media-image"
              src={image.thumb}
              alt={image.alt}
              loading="lazy"
            />
          </a>
          {image.alt && <AltBadge text={image.alt} />}
        </div>
      ))}
    </div>
  )
}

function VideoEmbed({ video }: { video: AppBskyEmbedVideo.View }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [shouldLoad, setShouldLoad] = useState(false)

  useEffect(() => {
    const element = videoRef.current
    if (!element) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setShouldLoad(true)
        observer.disconnect()
      },
      { rootMargin: '400px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = videoRef.current
    if (!element || !shouldLoad) return

    const mediaElement = element
    let cancelled = false
    let hls: HlsPlayer | null = null

    async function attachStream() {
      const { default: Hls } = await import('hls.js')
      if (cancelled) return

      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true })
        hls.loadSource(video.playlist)
        hls.attachMedia(mediaElement)
      } else {
        mediaElement.src = video.playlist
      }
    }

    void attachStream()
    return () => {
      cancelled = true
      hls?.destroy()
    }
  }, [shouldLoad, video.playlist])

  return (
    <div
      className="video-embed"
      style={
        video.aspectRatio
          ? { aspectRatio: `${video.aspectRatio.width} / ${video.aspectRatio.height}` }
          : undefined
      }
    >
      <video
        ref={videoRef}
        controls
        playsInline
        preload="metadata"
        poster={video.thumbnail}
        aria-label={video.alt || 'Embedded video'}
      />
      {video.alt && <AltBadge text={video.alt} />}
    </div>
  )
}

function PostMedia({ embed }: { embed: AppBskyFeedDefs.PostView['embed'] }) {
  if (!embed) return null

  const media: unknown = AppBskyEmbedRecordWithMedia.isView(embed)
    ? embed.media
    : embed

  if (AppBskyEmbedImages.isView(media)) {
    const imageView = media as AppBskyEmbedImages.View
    return <ImageGallery images={imageView.images} />
  }

  if (AppBskyEmbedGallery.isView(media)) {
    const galleryView = media as AppBskyEmbedGallery.View
    const images: MediaImage[] = []
    for (const item of galleryView.items) {
      if (!AppBskyEmbedGallery.isViewImage(item)) continue
      const image = item as AppBskyEmbedGallery.ViewImage
      images.push({
        thumb: image.thumbnail,
        fullsize: image.fullsize,
        alt: image.alt,
        aspectRatio: image.aspectRatio,
      })
    }
    return <ImageGallery images={images} />
  }

  if (AppBskyEmbedVideo.isView(media)) {
    return <VideoEmbed video={media as AppBskyEmbedVideo.View} />
  }

  return null
}

function quotedPostFromView(record: AppBskyEmbedRecord.ViewRecord) {
  return {
    uri: record.uri,
    cid: record.cid,
    author: record.author,
    record: record.value,
    embed: record.embeds?.[0] as AppBskyFeedDefs.PostView['embed'],
    replyCount: record.replyCount,
    repostCount: record.repostCount,
    likeCount: record.likeCount,
    quoteCount: record.quoteCount,
    indexedAt: record.indexedAt,
    labels: record.labels,
  } satisfies AppBskyFeedDefs.PostView
}

function QuotePost({
  embed,
  onOpenThread,
}: {
  embed: AppBskyFeedDefs.PostView['embed']
  onOpenThread?: (post: AppBskyFeedDefs.PostView) => void
}) {
  if (!embed) return null

  const recordEmbed = AppBskyEmbedRecordWithMedia.isView(embed)
    ? embed.record
    : AppBskyEmbedRecord.isView(embed)
      ? embed
      : null
  if (!recordEmbed) return null

  const quoted = recordEmbed.record
  if (AppBskyEmbedRecord.isViewBlocked(quoted)) {
    return <div className="quote-card quote-unavailable">Post from a blocked account</div>
  }
  if (AppBskyEmbedRecord.isViewDetached(quoted)) {
    return <div className="quote-card quote-unavailable">Quote removed by the original poster</div>
  }
  if (AppBskyEmbedRecord.isViewNotFound(quoted)) {
    return <div className="quote-card quote-unavailable">Quoted post unavailable</div>
  }
  if (!AppBskyEmbedRecord.isViewRecord(quoted) || !AppBskyFeedPost.isRecord(quoted.value)) {
    return null
  }

  const post = quotedPostFromView(quoted)
  const record = quoted.value as AppBskyFeedPost.Record
  const openQuote = () => {
    if (onOpenThread) {
      onOpenThread(post)
    } else {
      window.open(postUrl(post), '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div
      className="quote-card quote-card-interactive"
      role="link"
      tabIndex={0}
      aria-label={`Open quoted post by @${quoted.author.handle}`}
      onClick={openQuote}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        openQuote()
      }}
    >
      <div className="quote-author-line">
        <a
          href={profileHref(quoted.author.handle)}
          onClick={(event) => event.stopPropagation()}
          aria-label={`View @${quoted.author.handle}'s profile`}
        >
          {quoted.author.avatar ? (
            <img className="quote-avatar" src={quoted.author.avatar} alt="" width="22" height="22" />
          ) : (
            <span className="quote-avatar quote-avatar-fallback" aria-hidden="true">
              {quoted.author.handle.slice(0, 1).toUpperCase()}
            </span>
          )}
        </a>
        <a
          className="quote-author"
          href={profileHref(quoted.author.handle)}
          onClick={(event) => event.stopPropagation()}
        >
          <strong>{quoted.author.displayName || quoted.author.handle}</strong>
          <span>@{quoted.author.handle}</span>
        </a>
        <span className="quote-separator" aria-hidden="true">·</span>
        <time dateTime={quoted.indexedAt} title={formatDate(quoted.indexedAt)}>
          {formatQuoteDate(quoted.indexedAt)}
        </time>
      </div>
      {record.text && <p className="quote-text">{record.text}</p>}
      {post.embed && (
        <div className="quote-media" onClick={(event) => event.stopPropagation()}>
          <PostMedia embed={post.embed} />
        </div>
      )}
    </div>
  )
}

function PostEmbed({
  embed,
  onOpenThread,
}: {
  embed: AppBskyFeedDefs.PostView['embed']
  onOpenThread?: (post: AppBskyFeedDefs.PostView) => void
}) {
  if (!embed) return null

  return (
    <>
      <PostMedia embed={embed} />
      <QuotePost embed={embed} onOpenThread={onOpenThread} />
    </>
  )
}

const singleReplyCache = new Map<
  string,
  Promise<AppBskyFeedDefs.PostView | null>
>()

function getSingleReply(uri: string) {
  const cached = singleReplyCache.get(uri)
  if (cached) return cached

  const request = publicAgent.app.bsky.feed
    .getPostThread({ uri, depth: 1, parentHeight: 0 })
    .then((response) => {
      if (!AppBskyFeedDefs.isThreadViewPost(response.data.thread)) return null
      const thread = response.data.thread as AppBskyFeedDefs.ThreadViewPost
      const replies = (thread.replies ?? []).filter(AppBskyFeedDefs.isThreadViewPost)
      if (replies.length !== 1) return null
      return (replies[0] as AppBskyFeedDefs.ThreadViewPost).post
    })
    .catch(() => null)

  singleReplyCache.set(uri, request)
  return request
}

function PostCard({
  post,
  repost,
  nested = false,
  onOpenThread,
}: {
  post: AppBskyFeedDefs.PostView
  repost?: AppBskyActorDefs.ProfileViewBasic
  nested?: boolean
  onOpenThread?: (post: AppBskyFeedDefs.PostView) => void
}) {
  const record = AppBskyFeedPost.isRecord(post.record) ? post.record : null
  const openEngagement = useContext(EngagementContext)
  const repostCount = (post.repostCount ?? 0) + (post.quoteCount ?? 0)

  return (
    <article className={`post${nested ? ' nested-post' : ''}`}>
      {repost && (
        <p className="repost">Reposted by @{repost.handle}</p>
      )}
      <div className="post-grid">
        <a
          className="avatar-link"
          href={profileHref(post.author.handle)}
          aria-label={`View @${post.author.handle}'s profile`}
        >
          {post.author.avatar ? (
            <img
              className="avatar"
              src={post.author.avatar}
              alt=""
              width="48"
              height="48"
            />
          ) : (
            <span className="avatar avatar-fallback" aria-hidden="true">
              {post.author.handle.slice(0, 1).toUpperCase()}
            </span>
          )}
        </a>
        <div className="post-body">
          <a className="author-line" href={profileHref(post.author.handle)}>
            <strong>{post.author.displayName || post.author.handle}</strong>
            <span>@{post.author.handle}</span>
          </a>
          {record && typeof record.text === 'string' ? (
            <p className="post-text">{record.text}</p>
          ) : (
            <p className="post-text unavailable">Unsupported post format</p>
          )}
          <PostEmbed embed={post.embed} onOpenThread={onOpenThread} />
          <div className="post-meta">
            <time dateTime={post.indexedAt}>
              {formatDate(post.indexedAt)}
            </time>
            <span aria-hidden="true">·</span>
            {onOpenThread && (post.replyCount ?? 0) > 0 ? (
              <button type="button" onClick={() => onOpenThread(post)}>
                {post.replyCount ?? 0} replies
              </button>
            ) : (
              <span>{post.replyCount ?? 0} replies</span>
            )}
            <span aria-hidden="true">·</span>
            {openEngagement && repostCount > 0 ? (
              <button type="button" onClick={() => openEngagement('reposts', post)}>
                {repostCount} reposts
              </button>
            ) : (
              <span>{repostCount} reposts</span>
            )}
            <span aria-hidden="true">·</span>
            {openEngagement && (post.likeCount ?? 0) > 0 ? (
              <button type="button" onClick={() => openEngagement('likes', post)}>
                {post.likeCount ?? 0} likes
              </button>
            ) : (
              <span>{post.likeCount ?? 0} likes</span>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

function ThreadAwarePost({
  post,
  repost,
  onOpenThread,
}: {
  post: AppBskyFeedDefs.PostView
  repost?: AppBskyActorDefs.ProfileViewBasic
  onOpenThread: (post: AppBskyFeedDefs.PostView) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const replyRef = useRef<HTMLDivElement | null>(null)
  const [reply, setReply] = useState<AppBskyFeedDefs.PostView | null>(null)
  const [fitsInline, setFitsInline] = useState<boolean | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container || post.replyCount !== 1) return

    let cancelled = false
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        observer.disconnect()
        void getSingleReply(post.uri).then((result) => {
          if (!cancelled && result) setReply(result)
        })
      },
      { rootMargin: '300px 0px' },
    )
    observer.observe(container)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [post.replyCount, post.uri])

  useEffect(() => {
    const container = containerRef.current
    const replyElement = replyRef.current
    if (!reply || !container || !replyElement) return

    const parent = container.querySelector(':scope > .post') as HTMLElement | null
    if (!parent) return

    const measure = () => {
      const combinedHeight = parent.getBoundingClientRect().height
        + replyElement.getBoundingClientRect().height
      setFitsInline(combinedHeight <= window.innerHeight * 0.6)
    }

    const frame = window.requestAnimationFrame(measure)
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(parent)
    resizeObserver.observe(replyElement)
    window.addEventListener('resize', measure)
    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [reply])

  return (
    <div className="thread-aware-post" ref={containerRef}>
      <PostCard post={post} repost={repost} onOpenThread={onOpenThread} />
      {reply && (
        <div
          ref={replyRef}
          className={`inline-reply${fitsInline === true ? ' inline-reply-visible' : ''}`}
          aria-hidden={fitsInline !== true}
        >
          <span className="reply-connector" aria-hidden="true" />
          <PostCard post={reply} nested onOpenThread={onOpenThread} />
        </div>
      )}
    </div>
  )
}

function FeedPost({
  item,
  onOpenThread,
}: {
  item: AppBskyFeedDefs.FeedViewPost
  onOpenThread: (post: AppBskyFeedDefs.PostView) => void
}) {
  const repost = AppBskyFeedDefs.isReasonRepost(item.reason)
    ? item.reason.by
    : undefined

  return (
    <ThreadAwarePost
      post={item.post}
      repost={repost}
      onOpenThread={onOpenThread}
    />
  )
}

function isAuthoredReply(item: AppBskyFeedDefs.FeedViewPost) {
  if (AppBskyFeedDefs.isReasonRepost(item.reason)) return false
  const record = AppBskyFeedPost.isRecord(item.post.record)
    ? item.post.record
    : null
  return Boolean(record?.reply)
}

function ProfileFeedItem({
  item,
  onOpenThread,
}: {
  item: AppBskyFeedDefs.FeedViewPost
  onOpenThread: (post: AppBskyFeedDefs.PostView) => void
}) {
  if (!isAuthoredReply(item)) {
    return <FeedPost item={item} onOpenThread={onOpenThread} />
  }

  const parent = item.reply?.parent
  const parentPost = parent && AppBskyFeedDefs.isPostView(parent) ? parent : null
  return (
    <div className="profile-reply-pair">
      <div className={`profile-reply-parent${parentPost ? ' profile-reply-parent-visible' : ''}`}>
        {parentPost ? (
          <PostCard post={parentPost} nested onOpenThread={onOpenThread} />
        ) : (
          <p className="profile-reply-parent-unavailable">
            {parent && AppBskyFeedDefs.isBlockedPost(parent)
              ? 'Parent post is from a blocked account'
              : 'Parent post unavailable'}
          </p>
        )}
      </div>
      <div className="profile-reply-child">
        <PostCard post={item.post} nested onOpenThread={onOpenThread} />
      </div>
    </div>
  )
}

function flattenReplies(thread: AppBskyFeedDefs.ThreadViewPost) {
  const replies: AppBskyFeedDefs.PostView[] = []
  const visit = (node: AppBskyFeedDefs.ThreadViewPost) => {
    for (const child of node.replies ?? []) {
      if (!AppBskyFeedDefs.isThreadViewPost(child)) continue
      const childThread = child as AppBskyFeedDefs.ThreadViewPost
      replies.push(childThread.post)
      visit(childThread)
    }
  }
  visit(thread)
  return replies
}

function flattenParents(thread: AppBskyFeedDefs.ThreadViewPost) {
  const parents: AppBskyFeedDefs.PostView[] = []
  let parent = thread.parent
  while (parent && AppBskyFeedDefs.isThreadViewPost(parent)) {
    const parentThread = parent as AppBskyFeedDefs.ThreadViewPost
    parents.unshift(parentThread.post)
    parent = parentThread.parent
  }
  return parents
}

function ThreadPanel({
  selected,
  thread,
  loading,
  error,
  onClose,
  onOpenThread,
}: {
  selected: AppBskyFeedDefs.PostView
  thread: AppBskyFeedDefs.ThreadViewPost | null
  loading: boolean
  error: string
  onClose: () => void
  onOpenThread: (post: AppBskyFeedDefs.PostView) => void
}) {
  const replies = thread ? flattenReplies(thread) : []
  const parents = thread ? flattenParents(thread) : []
  const conversationPost = thread?.post ?? selected

  return (
    <section
      className="thread-panel"
      aria-label="Conversation"
    >
      <button
        type="button"
        className="thread-panel-close"
        onClick={onClose}
        aria-label="Close conversation"
      >
        ×
      </button>
      {loading ? (
        <div className="trends-loading" aria-live="polite">
          <div className="spinner spinner-small" />
          <span>Loading replies…</span>
        </div>
      ) : error ? (
        <p className="trends-message">{error}</p>
      ) : (
        <div className="thread-panel-posts">
          <div className="thread-parent-chain">
            {parents.map((parent) => (
              <div className="thread-context-post" key={parent.uri}>
                <PostCard post={parent} nested onOpenThread={onOpenThread} />
              </div>
            ))}
            <div className="thread-context-post thread-selected-post">
              <PostCard post={conversationPost} nested onOpenThread={onOpenThread} />
            </div>
          </div>
          {replies.length > 0 ? (
            <div className="thread-descendants">
              {replies.map((reply) => (
                <PostCard key={reply.uri} post={reply} nested onOpenThread={onOpenThread} />
              ))}
            </div>
          ) : (
            <p className="trends-message">No visible replies.</p>
          )}
        </div>
      )}
    </section>
  )
}

function AccountCard({ profile }: { profile: AppBskyActorDefs.ProfileView }) {
  return (
    <a className="account-card" href={profileHref(profile.handle)}>
      {profile.avatar ? (
        <img className="avatar" src={profile.avatar} alt="" width="48" height="48" />
      ) : (
        <div className="avatar avatar-fallback" aria-hidden="true">
          {profile.handle.slice(0, 1).toUpperCase()}
        </div>
      )}
      <span className="account-card-body">
        <strong>{profile.displayName || profile.handle}</strong>
        <span>@{profile.handle}</span>
        {profile.description && <small>{profile.description}</small>}
      </span>
    </a>
  )
}

function EngagementActorRow({ profile }: { profile: AppBskyActorDefs.ProfileView }) {
  return (
    <a className="engagement-actor" href={profileHref(profile.handle)}>
      {profile.avatar ? (
        <img className="engagement-avatar" src={profile.avatar} alt="" width="38" height="38" />
      ) : (
        <span className="engagement-avatar avatar-fallback" aria-hidden="true">
          {profile.handle.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="engagement-actor-copy">
        <strong>{profile.displayName || profile.handle}</strong>
        <span>@{profile.handle}</span>
      </span>
    </a>
  )
}

function EngagementPanel({
  kind,
  post,
  actors,
  quotes,
  loading,
  error,
  currentDid,
  onClose,
  onOpenThread,
  onBlockActors,
}: {
  kind: EngagementKind
  post: AppBskyFeedDefs.PostView
  actors: AppBskyActorDefs.ProfileView[]
  quotes: AppBskyFeedDefs.PostView[]
  loading: boolean
  error: string
  currentDid: string
  onClose: () => void
  onOpenThread: (post: AppBskyFeedDefs.PostView) => void
  onBlockActors: (actors: AppBskyActorDefs.ProfileView[]) => Promise<BulkBlockResult>
}) {
  const record = AppBskyFeedPost.isRecord(post.record) ? post.record : null
  const title = kind === 'likes' ? 'Likes' : 'Reposts'
  const [confirmingBlock, setConfirmingBlock] = useState(false)
  const [blocking, setBlocking] = useState(false)
  const [blockedDids, setBlockedDids] = useState<string[]>([])
  const [blockMessage, setBlockMessage] = useState('')
  const blockableActors = kind === 'likes'
    ? actors.filter((actor) => (
        actor.did !== currentDid &&
        !actor.viewer?.blocking &&
        !blockedDids.includes(actor.did)
      ))
    : []
  const skippedActorCount = kind === 'likes' ? actors.length - blockableActors.length : 0

  async function blockAllShown() {
    setBlocking(true)
    setBlockMessage('')
    try {
      const result = await onBlockActors(blockableActors)
      setBlockedDids((current) => [...new Set([...current, ...result.blockedDids])])
      setBlockMessage(
        result.failedDids.length > 0
          ? `Blocked ${result.blockedDids.length} account${result.blockedDids.length === 1 ? '' : 's'}; ${result.failedDids.length} failed.`
          : `Blocked ${result.blockedDids.length} account${result.blockedDids.length === 1 ? '' : 's'}.`,
      )
      setConfirmingBlock(false)
    } catch (cause) {
      setBlockMessage(cause instanceof Error ? cause.message : 'Could not block these accounts.')
    } finally {
      setBlocking(false)
    }
  }

  return (
    <section className="thread-panel engagement-panel" aria-label={title}>
      <button
        type="button"
        className="thread-panel-close"
        onClick={onClose}
        aria-label={`Close ${title.toLowerCase()}`}
      >
        ×
      </button>
      <div className="engagement-source">
        <strong>{post.author.displayName || post.author.handle}</strong>
        {record && typeof record.text === 'string' && record.text && <p>{record.text}</p>}
      </div>
      <div className="engagement-summary">
        <strong>{title}</strong>
        {!loading && !error && (
          <span>
            {kind === 'likes'
              ? `${actors.length} ${actors.length === 1 ? 'account' : 'accounts'}`
              : `${actors.length} repost${actors.length === 1 ? '' : 's'} · ${quotes.length} quote${quotes.length === 1 ? '' : 's'}`}
          </span>
        )}
      </div>
      {kind === 'likes' && !loading && !error && (
        <div className="bulk-block-control">
          {confirmingBlock ? (
            <div className="bulk-block-confirm" role="alertdialog" aria-label="Confirm bulk block">
              <p>
                Block {blockableActors.length} account{blockableActors.length === 1 ? '' : 's'}?
                This creates a Bluesky block for each one and may disrupt conversation threads.
              </p>
              {skippedActorCount > 0 && (
                <small>
                  {skippedActorCount} account{skippedActorCount === 1 ? '' : 's'} skipped:
                  your account and any already-blocked accounts are excluded.
                </small>
              )}
              <div className="bulk-block-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setConfirmingBlock(false)}
                  disabled={blocking}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => void blockAllShown()}
                  disabled={blocking || blockableActors.length === 0}
                >
                  {blocking ? 'Blocking…' : `Block ${blockableActors.length} accounts`}
                </button>
              </div>
            </div>
          ) : blockableActors.length > 0 ? (
            <button
              type="button"
              className="bulk-block-button"
              onClick={() => setConfirmingBlock(true)}
            >
              Block all {blockableActors.length} shown
            </button>
          ) : null}
          {blockMessage && <p className="bulk-block-message" role="status">{blockMessage}</p>}
        </div>
      )}
      {loading ? (
        <div className="trends-loading" aria-live="polite">
          <div className="spinner spinner-small" />
          <span>Loading {title.toLowerCase()}…</span>
        </div>
      ) : error ? (
        <p className="trends-message">{error}</p>
      ) : (
        <>
          {actors.length > 0 && (
            <div className="engagement-actor-list">
              {actors.map((actor) => (
                <EngagementActorRow key={actor.did} profile={actor} />
              ))}
            </div>
          )}
          {kind === 'reposts' && quotes.length > 0 && (
            <div className="engagement-quotes">
              <p className="engagement-section-label">Quote posts</p>
              {quotes.map((quote) => (
                <PostCard key={quote.uri} post={quote} nested onOpenThread={onOpenThread} />
              ))}
            </div>
          )}
          {actors.length === 0 && quotes.length === 0 && (
            <p className="trends-message">No visible {title.toLowerCase()}.</p>
          )}
        </>
      )}
    </section>
  )
}

function SettingsPage({ signedInHandle }: { signedInHandle: string }) {
  return (
    <div className="settings-page">
      <div className="settings-heading">
        <p className="eyebrow">Preferences</p>
        <h1>Settings</h1>
      </div>
      <section className="settings-card">
        <h2>Account</h2>
        <p>Signed in as <strong>@{signedInHandle}</strong></p>
      </section>
      <section className="settings-card">
        <h2>AI &amp; moderation</h2>
        <p>
          LLM provider, personal values, and automated blocking controls will be
          configured here as they are added to osky.
        </p>
      </section>
    </div>
  )
}

function ProfilePage({
  profile,
  feed,
  loading,
  error,
  feedMode,
  feedLoading,
  feedError,
  onFeedModeChange,
  onOpenThread,
}: {
  profile: AppBskyActorDefs.ProfileViewDetailed | null
  feed: AppBskyFeedDefs.FeedViewPost[]
  loading: boolean
  error: string
  feedMode: ProfileFeedMode
  feedLoading: boolean
  feedError: string
  onFeedModeChange: (mode: ProfileFeedMode) => void
  onOpenThread: (post: AppBskyFeedDefs.PostView) => void
}) {
  if (loading) {
    return (
      <div className="profile-loading" aria-live="polite">
        <div className="spinner" />
        <span>Opening profile…</span>
      </div>
    )
  }

  if (error || !profile) {
    return (
      <div className="profile-message">
        <p className="error">{error || 'Could not load this profile.'}</p>
        <a className="secondary-button button-link" href="#">
          Back
        </a>
      </div>
    )
  }

  return (
    <div className="profile-page">
      <section className="profile-header">
        <a className="profile-back" href="#" aria-label="Back">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M19 12H5m7-7-7 7 7 7"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.25"
            />
          </svg>
        </a>
        {profile.banner ? (
          <img className="profile-banner" src={profile.banner} alt="" />
        ) : (
          <div className="profile-banner profile-banner-fallback" />
        )}
        <div className="profile-summary">
          {profile.avatar ? (
            <img
              className="profile-avatar"
              src={profile.avatar}
              alt=""
              width="104"
              height="104"
            />
          ) : (
            <div className="profile-avatar profile-avatar-fallback" aria-hidden="true">
              {profile.handle.slice(0, 1).toUpperCase()}
            </div>
          )}
          <h1>{profile.displayName || profile.handle}</h1>
          <p className="profile-handle">@{profile.handle}</p>
          {(profile.viewer?.following || profile.viewer?.followedBy) && (
            <div className="profile-relationships" aria-label="Account relationship">
              {profile.viewer.following && <span>Following</span>}
              {profile.viewer.followedBy && <span>Follows you</span>}
            </div>
          )}
          {profile.description && (
            <p className="profile-description">{profile.description}</p>
          )}
          <dl className="profile-stats">
            <div>
              <dt>Posts</dt>
              <dd>{profile.postsCount?.toLocaleString() ?? '—'}</dd>
            </div>
            <div>
              <dt>Following</dt>
              <dd>{profile.followsCount?.toLocaleString() ?? '—'}</dd>
            </div>
            <div>
              <dt>Followers</dt>
              <dd>{profile.followersCount?.toLocaleString() ?? '—'}</dd>
            </div>
          </dl>
        </div>
        <div className="profile-feed-tabs" role="tablist" aria-label="Profile posts">
          {(['posts', 'replies', 'both'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={feedMode === mode}
              className={feedMode === mode ? 'active' : undefined}
              onClick={() => onFeedModeChange(mode)}
            >
              {mode === 'posts' ? 'Posts' : mode === 'replies' ? 'Replies' : 'Both'}
            </button>
          ))}
        </div>
      </section>

      <section className="profile-posts" aria-label={`${feedMode} by this account`}>
        {feedLoading ? (
          <div className="profile-feed-loading" aria-live="polite">
            <div className="spinner spinner-small" />
            <span>Loading {feedMode}…</span>
          </div>
        ) : feedError ? (
          <p className="error">{feedError}</p>
        ) : feed.length > 0 ? (
          <div className="feed" aria-live="polite">
            {feed.map((item, index) => (
              <ProfileFeedItem
                key={`${item.post.uri}-${index}`}
                item={item}
                onOpenThread={onOpenThread}
              />
            ))}
          </div>
        ) : (
          <p className="empty-results">No recent {feedMode}.</p>
        )}
      </section>
    </div>
  )
}

export default function App() {
  const oauthRef = useRef<BrowserOAuthClient | null>(null)
  const agentRef = useRef<Agent | null>(null)
  const didRef = useRef<string | null>(null)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const loadingRef = useRef(false)
  const engagementRequestRef = useRef(0)
  const [status, setStatus] = useState<'starting' | 'signed-out' | 'signed-in'>('starting')
  const [handle, setHandle] = useState('')
  const [signedInHandle, setSignedInHandle] = useState('')
  const [feed, setFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [canSearch, setCanSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestions, setSuggestions] = useState<AppBskyActorDefs.ProfileViewBasic[]>([])
  const [accountResults, setAccountResults] = useState<AppBskyActorDefs.ProfileView[]>([])
  const [postResults, setPostResults] = useState<AppBskyFeedDefs.PostView[]>([])
  const [trends, setTrends] = useState<AppBskyUnspeccedDefs.TrendView[]>([])
  const [trendsLoading, setTrendsLoading] = useState(false)
  const [trendsError, setTrendsError] = useState('')
  const [profileActor, setProfileActor] = useState<string | null>(profileActorFromHash)
  const [settingsOpen, setSettingsOpen] = useState(settingsFromHash)
  const [profile, setProfile] = useState<AppBskyActorDefs.ProfileViewDetailed | null>(null)
  const [profileFeed, setProfileFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileFeedMode, setProfileFeedMode] = useState<ProfileFeedMode>('posts')
  const [profileFeedLoading, setProfileFeedLoading] = useState(false)
  const [profileFeedError, setProfileFeedError] = useState('')
  const [selectedThreadPost, setSelectedThreadPost] = useState<AppBskyFeedDefs.PostView | null>(null)
  const [thread, setThread] = useState<AppBskyFeedDefs.ThreadViewPost | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [threadError, setThreadError] = useState('')
  const [engagementPanel, setEngagementPanel] = useState<{
    kind: EngagementKind
    post: AppBskyFeedDefs.PostView
  } | null>(null)
  const [engagementActors, setEngagementActors] = useState<AppBskyActorDefs.ProfileView[]>([])
  const [engagementQuotes, setEngagementQuotes] = useState<AppBskyFeedDefs.PostView[]>([])
  const [engagementLoading, setEngagementLoading] = useState(false)
  const [engagementError, setEngagementError] = useState('')
  const [showScrollTop, setShowScrollTop] = useState(false)

  const openEngagement = useCallback(async (
    kind: EngagementKind,
    post: AppBskyFeedDefs.PostView,
  ) => {
    const requestId = ++engagementRequestRef.current
    setSelectedThreadPost(null)
    setThread(null)
    setThreadError('')
    setEngagementPanel({ kind, post })
    setEngagementActors([])
    setEngagementQuotes([])
    setEngagementError('')
    setEngagementLoading(true)

    try {
      if (kind === 'likes') {
        const response = await publicAgent.app.bsky.feed.getLikes({
          uri: post.uri,
          cid: post.cid,
          limit: 100,
        })
        if (requestId === engagementRequestRef.current) {
          let actors = response.data.likes.map((like) => like.actor)
          if (didRef.current) {
            const relationships = await getRelationships(
              didRef.current,
              actors.map((actor) => actor.did),
            )
            actors = actors.map((actor) => {
              const relationship = relationships.get(actor.did)
              if (!relationship) return actor
              return {
                ...actor,
                viewer: {
                  ...actor.viewer,
                  following: relationship.following,
                  followedBy: relationship.followedBy,
                  blocking: relationship.blocking,
                  blockedBy: Boolean(relationship.blockedBy),
                },
              }
            })
          }
          if (requestId === engagementRequestRef.current) setEngagementActors(actors)
        }
      } else {
        const [repostsResponse, quotesResponse] = await Promise.all([
          publicAgent.app.bsky.feed.getRepostedBy({ uri: post.uri, cid: post.cid, limit: 100 }),
          publicAgent.app.bsky.feed.getQuotes({ uri: post.uri, cid: post.cid, limit: 100 }),
        ])
        if (requestId === engagementRequestRef.current) {
          setEngagementActors(repostsResponse.data.repostedBy)
          setEngagementQuotes(quotesResponse.data.posts)
        }
      }
    } catch (cause) {
      if (requestId === engagementRequestRef.current) {
        setEngagementError(cause instanceof Error ? cause.message : `Could not load ${kind}.`)
      }
    } finally {
      if (requestId === engagementRequestRef.current) setEngagementLoading(false)
    }
  }, [])

  const blockActors = useCallback(async (
    actors: AppBskyActorDefs.ProfileView[],
  ): Promise<BulkBlockResult> => {
    const agent = agentRef.current
    const repo = didRef.current
    if (!agent || !repo) throw new Error('You must be signed in to block accounts.')

    const blockedDids: string[] = []
    const failedDids: string[] = []
    for (const actor of actors) {
      try {
        await agent.app.bsky.graph.block.create(
          { repo },
          { subject: actor.did, createdAt: new Date().toISOString() },
        )
        blockedDids.push(actor.did)
      } catch {
        failedDids.push(actor.did)
      }
    }
    return { blockedDids, failedDids }
  }, [])

  const openThread = useCallback(async (post: AppBskyFeedDefs.PostView) => {
    engagementRequestRef.current += 1
    setEngagementPanel(null)
    setSelectedThreadPost(post)
    setThread(null)
    setThreadError('')
    setThreadLoading(true)
    try {
      const response = await publicAgent.app.bsky.feed.getPostThread({
        uri: post.uri,
        depth: 1000,
        parentHeight: 100,
      })
      if (!AppBskyFeedDefs.isThreadViewPost(response.data.thread)) {
        throw new Error('This conversation is unavailable.')
      }
      setThread(response.data.thread as AppBskyFeedDefs.ThreadViewPost)
    } catch (cause) {
      setThreadError(
        cause instanceof Error ? cause.message : 'Could not load this conversation.',
      )
    } finally {
      setThreadLoading(false)
    }
  }, [])

  const closeThread = useCallback(() => {
    setSelectedThreadPost(null)
    setThread(null)
    setThreadError('')
  }, [])

  const closeEngagement = useCallback(() => {
    engagementRequestRef.current += 1
    setEngagementPanel(null)
    setEngagementActors([])
    setEngagementQuotes([])
    setEngagementError('')
  }, [])

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
    if (
      status !== 'signed-in' ||
      submittedSearch ||
      profileActor ||
      settingsOpen ||
      !cursor ||
      !sentinel
    ) return

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
  }, [cursor, loadFeed, profileActor, settingsOpen, status, submittedSearch])

  useEffect(() => {
    const update = () => setShowScrollTop(window.scrollY > 320)
    update()
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [])

  useEffect(() => {
    const syncRoute = () => {
      setProfileActor(profileActorFromHash())
      setSettingsOpen(settingsFromHash())
      setProfileFeedMode('posts')
      window.scrollTo({ top: 0 })
    }

    window.addEventListener('hashchange', syncRoute)
    return () => window.removeEventListener('hashchange', syncRoute)
  }, [])

  useEffect(() => {
    if (!profileActor) return

    let cancelled = false
    setProfile(null)
    setProfileError('')
    setProfileLoading(true)

    async function loadProfile() {
      try {
        const profileResponse = await publicAgent.app.bsky.actor.getProfile({
          actor: profileActor as string,
        })
        if (cancelled) return
        const profileData = profileResponse.data
        if (didRef.current && profileData.did !== didRef.current) {
          const relationships = await getRelationships(didRef.current, [profileData.did])
          const relationship = relationships.get(profileData.did)
          if (cancelled) return
          if (relationship) {
            setProfile({
              ...profileData,
              viewer: {
                ...profileData.viewer,
                following: relationship.following,
                followedBy: relationship.followedBy,
                blocking: relationship.blocking,
                blockedBy: Boolean(relationship.blockedBy),
              },
            })
            return
          }
        }
        setProfile(profileData)
      } catch (cause) {
        if (!cancelled) {
          setProfileError(
            cause instanceof Error ? cause.message : 'Could not load this profile.',
          )
        }
      } finally {
        if (!cancelled) setProfileLoading(false)
      }
    }

    void loadProfile()
    return () => {
      cancelled = true
    }
  }, [profileActor])

  useEffect(() => {
    if (!profileActor) return

    let cancelled = false
    setProfileFeed([])
    setProfileFeedError('')
    setProfileFeedLoading(true)

    async function loadProfileFeed() {
      try {
        const response = await publicAgent.app.bsky.feed.getAuthorFeed({
          actor: profileActor as string,
          filter: profileFeedMode === 'posts' ? 'posts_no_replies' : 'posts_with_replies',
          limit: profileFeedMode === 'both' ? 30 : 100,
        })
        if (cancelled) return

        const nextFeed = profileFeedMode === 'posts'
          ? response.data.feed.filter((item) => !isAuthoredReply(item)).slice(0, 30)
          : profileFeedMode === 'replies'
            ? response.data.feed.filter(isAuthoredReply).slice(0, 30)
            : response.data.feed
        setProfileFeed(nextFeed)
      } catch (cause) {
        if (!cancelled) {
          setProfileFeedError(
            cause instanceof Error ? cause.message : 'Could not load these posts.',
          )
        }
      } finally {
        if (!cancelled) setProfileFeedLoading(false)
      }
    }

    void loadProfileFeed()
    return () => {
      cancelled = true
    }
  }, [profileActor, profileFeedMode])

  useEffect(() => {
    if (status !== 'signed-in') return

    let cancelled = false
    setTrendsLoading(true)
    setTrendsError('')

    async function loadTrends() {
      try {
        const response = await publicAgent.app.bsky.unspecced.getTrends({ limit: 6 })
        if (!cancelled) setTrends(response.data.trends)
      } catch {
        if (!cancelled) setTrendsError('Trending topics are unavailable right now.')
      } finally {
        if (!cancelled) setTrendsLoading(false)
      }
    }

    void loadTrends()
    return () => {
      cancelled = true
    }
  }, [status])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!searchFocused || !query) {
      setSuggestions([])
      setSuggesting(false)
      return
    }

    let cancelled = false
    const timeout = window.setTimeout(async () => {
      setSuggesting(true)
      try {
        const response = await publicAgent.app.bsky.actor.searchActorsTypeahead({
          q: query,
          limit: 6,
        })
        if (!cancelled) setSuggestions(response.data.actors)
      } catch {
        if (!cancelled) setSuggestions([])
      } finally {
        if (!cancelled) setSuggesting(false)
      }
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [searchFocused, searchQuery])

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
        const tokenInfo = await result.session.getTokenInfo()
        const grantedScopes = new Set(tokenInfo.scope.split(' '))
        setCanSearch(SEARCH_SCOPES.every((scope) => grantedScopes.has(scope)))
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

  async function authorize(identifier: string) {
    if (!oauthRef.current || !identifier.trim()) return

    setBusy(true)
    setError('')
    try {
      await oauthRef.current.signIn(identifier.trim(), {
        scope: SCOPE,
        state: crypto.randomUUID(),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.')
      setBusy(false)
    }
  }

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void authorize(handle)
  }

  async function runSearch(rawQuery: string) {
    const query = rawQuery.trim()
    const agent = agentRef.current
    if (!agent || !canSearch || !query) return

    setSearchQuery(query)
    setSearchFocused(false)
    setSearching(true)
    setError('')
    try {
      const [accounts, posts] = await Promise.all([
        agent.app.bsky.actor.searchActors({ q: query, limit: 10 }),
        agent.app.bsky.feed.searchPosts({ q: query, sort: 'top', limit: 30 }),
      ])
      setAccountResults(accounts.data.actors)
      setPostResults(posts.data.posts)
      setSubmittedSearch(query)
      if (window.location.hash) window.location.hash = ''
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Search failed.')
    } finally {
      setSearching(false)
    }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void runSearch(searchQuery)
  }

  function clearSearch() {
    setSubmittedSearch('')
    setAccountResults([])
    setPostResults([])
  }

  function goHome(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    clearSearch()
    closeThread()
    closeEngagement()
    setProfileActor(null)
    setSettingsOpen(false)
    window.history.pushState(null, '', `${window.location.pathname}${window.location.search}`)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function openSettings() {
    clearSearch()
    closeThread()
    closeEngagement()
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

  async function repairSignIn() {
    setBusy(true)
    setError('')
    try {
      if (oauthRef.current && didRef.current) {
        await oauthRef.current.revoke(didRef.current)
      }
    } finally {
      window.location.replace(`${window.location.origin}${window.location.pathname}`)
    }
  }

  return (
    <main className={`shell ${status === 'signed-in' ? 'shell-signed-in' : ''}`}>
      {status !== 'signed-in' && (
        <header className="masthead">
          <a className="wordmark" href="#" aria-label="osky home">
            <span className="mark">o</span>sky
          </a>
        </header>
      )}

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
        <EngagementContext.Provider value={openEngagement}>
        <div className="signed-in-layout">
          <aside className="left-sidebar" aria-label="osky navigation">
            <div className="left-sidebar-sticky">
              <a className="wordmark" href="#" aria-label="osky home" onClick={goHome}>
                <span className="mark">o</span>sky
              </a>
              <div className="account-menu">
                <button
                  type="button"
                  className="account-menu-trigger"
                  aria-haspopup="menu"
                  aria-label={`Account menu for @${signedInHandle}`}
                >
                  @{signedInHandle}
                </button>
                <div className="account-context-menu" role="menu">
                  <a
                    href={profileHref(signedInHandle)}
                    role="menuitem"
                    onClick={() => {
                      clearSearch()
                      closeThread()
                      closeEngagement()
                    }}
                  >
                    Profile
                  </a>
                  <button type="button" role="menuitem" onClick={signOut} disabled={busy}>
                    Sign out
                  </button>
                </div>
              </div>
              <nav className="left-nav" aria-label="Primary navigation">
                <a
                  className={`left-nav-link${!settingsOpen && !profileActor && !submittedSearch ? ' left-nav-link-active' : ''}`}
                  href="#"
                  onClick={goHome}
                  aria-current={!settingsOpen && !profileActor && !submittedSearch ? 'page' : undefined}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3.5 10.5 12 3l8.5 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-5v6H5a1.5 1.5 0 0 1-1.5-1.5v-9Z" />
                  </svg>
                  <span>Home</span>
                </a>
                <a
                  className={`left-nav-link${settingsOpen ? ' left-nav-link-active' : ''}`}
                  href="#/settings"
                  onClick={openSettings}
                  aria-current={settingsOpen ? 'page' : undefined}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.1 4.8.1-1.3-.1-1.3 2-1.6-2-3.4-2.4 1a8.8 8.8 0 0 0-2.2-1.3L15.1 2h-4.2l-.4 2.4c-.8.3-1.5.7-2.2 1.3l-2.4-1-2 3.4 2 1.6-.1 1.3.1 1.3-2 1.6 2 3.4 2.4-1c.7.6 1.4 1 2.2 1.3l.4 2.4h4.2l.4-2.4c.8-.3 1.5-.7 2.2-1.3l2.4 1 2-3.4-2-1.6Z" />
                  </svg>
                  <span>Settings</span>
                </a>
              </nav>
            </div>
          </aside>

          <section className="timeline">
          <div className="app-layout">
            <div className="primary-pane">
              {error && (
                isDpopKeyBindingError(error) ? (
                  <div className="error feed-error auth-recovery" role="alert">
                    <span>Your Bluesky sign-in has expired or become disconnected.</span>
                    <button type="button" onClick={repairSignIn} disabled={busy}>
                      {busy ? 'Reconnecting…' : 'Reconnect'}
                    </button>
                  </div>
                ) : (
                  <p className="error feed-error">{error}</p>
                )
              )}

          {settingsOpen ? (
            <SettingsPage signedInHandle={signedInHandle} />
          ) : profileActor ? (
            <ProfilePage
              profile={profile}
              feed={profileFeed}
              loading={profileLoading}
              error={profileError}
              feedMode={profileFeedMode}
              feedLoading={profileFeedLoading}
              feedError={profileFeedError}
              onFeedModeChange={setProfileFeedMode}
              onOpenThread={openThread}
            />
          ) : submittedSearch ? (
            <div className="search-results">
              <div className="feed-heading">
                <div>
                  <p className="eyebrow">Search results</p>
                  <h1>“{submittedSearch}”</h1>
                </div>
                <button className="secondary-button" onClick={clearSearch}>
                  Back to feed
                </button>
              </div>

              <section className="result-section" aria-labelledby="account-results-heading">
                <h2 id="account-results-heading">Accounts</h2>
                {accountResults.length > 0 ? (
                  <div className="account-results">
                    {accountResults.map((profile) => (
                      <AccountCard key={profile.did} profile={profile} />
                    ))}
                  </div>
                ) : (
                  <p className="empty-results">No matching accounts.</p>
                )}
              </section>

              <section className="result-section" aria-labelledby="post-results-heading">
                <h2 id="post-results-heading">Skeets</h2>
                {postResults.length > 0 ? (
                  <div className="feed" aria-live="polite">
                    {postResults.map((post, index) => (
                      <ThreadAwarePost
                        key={`${post.uri}-${index}`}
                        post={post}
                        onOpenThread={openThread}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="empty-results">No matching skeets.</p>
                )}
              </section>
            </div>
          ) : (
            <>
              <div className="feed-heading">
                <h1 className="following-title">FOLLOWING</h1>
                <button
                  className="secondary-button icon-button"
                  onClick={() => loadFeed()}
                  disabled={busy}
                  aria-label="Refresh feed"
                  title="Refresh feed"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M20 11a8 8 0 0 0-14.9-3M4 4v5h5m-5 4a8 8 0 0 0 14.9 3M20 20v-5h-5"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2.1"
                    />
                  </svg>
                </button>
              </div>

              <div className="feed" aria-live="polite">
                {feed.map((item, index) => (
                  <FeedPost
                    key={`${item.post.uri}-${index}`}
                    item={item}
                    onOpenThread={openThread}
                  />
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
            </>
          )}
            </div>

            <aside className="sidebar" aria-label="Search and trending topics">
              <div className="sidebar-sticky">
                <form
                  className="search-bar"
                  onSubmit={search}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setSearchFocused(false)
                    }
                  }}
                >
                  <label className="search-input">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeWidth="2.25"
                      />
                    </svg>
                    <input
                      type="search"
                      role="combobox"
                      aria-label="Search accounts and skeets"
                      aria-autocomplete="list"
                      aria-controls="account-suggestions"
                      aria-expanded={searchFocused && suggestions.length > 0}
                      placeholder="Search"
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      autoCapitalize="none"
                      autoCorrect="off"
                      autoComplete="off"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={!canSearch || searching || !searchQuery.trim()}
                  >
                    {searching ? '…' : 'Search'}
                  </button>

                  {searchFocused &&
                    searchQuery.trim() &&
                    (suggesting || suggestions.length > 0) && (
                      <div
                        id="account-suggestions"
                        className="search-suggestions"
                        role="listbox"
                        aria-label="Suggested accounts"
                      >
                        {suggestions.map((suggestion) => (
                          <a
                            key={suggestion.did}
                            className="search-suggestion"
                            href={profileHref(suggestion.handle)}
                            role="option"
                            aria-selected="false"
                            onClick={() => setSearchFocused(false)}
                          >
                            {suggestion.avatar ? (
                              <img
                                className="suggestion-avatar"
                                src={suggestion.avatar}
                                alt=""
                                width="38"
                                height="38"
                              />
                            ) : (
                              <span
                                className="suggestion-avatar avatar-fallback"
                                aria-hidden="true"
                              >
                                {suggestion.handle.slice(0, 1).toUpperCase()}
                              </span>
                            )}
                            <span className="suggestion-copy">
                              <strong>
                                {suggestion.displayName || suggestion.handle}
                              </strong>
                              <span>@{suggestion.handle}</span>
                            </span>
                          </a>
                        ))}
                        {suggesting && (
                          <p className="suggestion-status">Finding accounts…</p>
                        )}
                      </div>
                    )}
                </form>

                {!canSearch && (
                  <div className="permission-note">
                    <span>Search needs one additional read-only permission.</span>
                    <button onClick={() => authorize(signedInHandle)} disabled={busy}>
                      {busy ? 'Connecting…' : 'Enable search'}
                    </button>
                  </div>
                )}

                {engagementPanel ? (
                  <EngagementPanel
                    key={`${engagementPanel.kind}-${engagementPanel.post.uri}`}
                    kind={engagementPanel.kind}
                    post={engagementPanel.post}
                    actors={engagementActors}
                    quotes={engagementQuotes}
                    loading={engagementLoading}
                    error={engagementError}
                    currentDid={didRef.current ?? ''}
                    onClose={closeEngagement}
                    onOpenThread={openThread}
                    onBlockActors={blockActors}
                  />
                ) : selectedThreadPost ? (
                  <ThreadPanel
                    key={selectedThreadPost.uri}
                    selected={selectedThreadPost}
                    thread={thread}
                    loading={threadLoading}
                    error={threadError}
                    onClose={closeThread}
                    onOpenThread={openThread}
                  />
                ) : (
                <section className="trending-card" aria-labelledby="trending-heading">
                  <p className="eyebrow">Right now</p>
                  <h2 id="trending-heading">Trending</h2>
                  {trendsLoading ? (
                    <div className="trends-loading" aria-live="polite">
                      <div className="spinner spinner-small" />
                      <span>Finding trends…</span>
                    </div>
                  ) : trendsError ? (
                    <p className="trends-message">{trendsError}</p>
                  ) : (
                    <ol className="trend-list">
                      {trends.map((trend) => (
                        <li key={trend.link}>
                          <button
                            type="button"
                            className="trend-button"
                            onClick={() => void runSearch(trend.displayName)}
                            disabled={!canSearch || searching}
                          >
                            <span className="trend-name">{trend.displayName}</span>
                            <span className="trend-meta">
                              {formatCount(trend.postCount)} posts
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
                )}
              </div>
            </aside>
          </div>
          </section>
          {showScrollTop && (
            <div className="scroll-top-dock" aria-label="Back to top controls">
              <button
                type="button"
                className="secondary-button icon-button scroll-top-button"
                onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                aria-label="Back to top of feed"
                title="Back to top of feed"
              >
                <UpArrowIcon />
              </button>
            </div>
          )}
        </div>
        </EngagementContext.Provider>
      )}
    </main>
  )
}
