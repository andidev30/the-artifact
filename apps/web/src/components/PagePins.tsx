import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { CommentAnchor } from '../api'
import { describeHover, parseFrameMessage, type AnchorDraft, type Box, type ViewerMessage } from '../frameMessages'
import './PagePins.css'

// An open thread about an element, numbered as in the comments panel
export type AnchoredThread = { id: string; anchor: CommentAnchor; number: number; label: string }

// Where each thread's element is: on the page shown (with its box in the frame), changed (not found
// there any more), in another of the page's files, or not known yet
export type PinStatus = 'shown' | 'changed' | 'elsewhere'

export type FrameHelper = {
  // The helper answered from the page; null until it does, and for pages whose scripts stop it
  path: string | null
  anchored: AnchoredThread[]
  picking: boolean
  draft: (AnchorDraft & { version: number }) | null
  hover: string
  status: (a: AnchoredThread) => PinStatus | undefined
  boxes: Map<string, Box>
  startPick: () => void
  stopPick: () => void
  clearDraft: () => void
  setAnchored: (threads: AnchoredThread[]) => void
  show: (threadId: string) => void
  onFrameLoad: () => void
}

// The viewer's side of the comment helper in the page's frame (frameMessages.ts). Messages are taken
// only from this frame's window and only in a known shape, and a picked element only while the person
// is picking; everything they carry is used as text and numbers, never as markup or code.
export function useFrameHelper(frame: RefObject<HTMLIFrameElement | null>, enabled: boolean, version: number): FrameHelper {
  const [path, setPath] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [draft, setDraft] = useState<FrameHelper['draft']>(null)
  const [hover, setHover] = useState('')
  const [anchored, setAnchoredState] = useState<AnchoredThread[]>([])
  const [located, setLocated] = useState<{ path: string; pins: Map<number, Box | null> } | null>(null)
  const pickingRef = useRef(false)
  pickingRef.current = picking
  const versionRef = useRef(version)
  versionRef.current = version

  const send = useCallback(
    (message: ViewerMessage) => {
      // The frame has an opaque origin, so there is no origin to name. What goes there is the page's own
      // selectors and text, never comments.
      frame.current?.contentWindow?.postMessage({ artifact: 1, ...message }, '*')
    },
    [frame],
  )

  // A new version in the frame is a new document, with a helper of its own
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets when the version changes
  useEffect(() => {
    setPath(null)
    setPicking(false)
    setLocated(null)
  }, [version])

  useEffect(() => {
    if (!enabled) return
    function onMessage(e: MessageEvent) {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const m = parseFrameMessage(e.data)
      if (!m) return
      if (m.type === 'ready') {
        setPath(m.path)
        setLocated(null)
        // A new document in the frame isn't picking any more
        if (pickingRef.current) setPicking(false)
      } else if (m.type === 'located') {
        setLocated({ path: m.path, pins: new Map(m.pins.map((p) => [p.key, p.rect])) })
      } else if (!pickingRef.current) {
        // Picks, hovers and cancels only count while the person is picking
      } else if (m.type === 'picked') {
        setPicking(false)
        setDraft({ ...m.anchor, version: versionRef.current })
        setHover(m.anchor.snippet ? `Pinned to “${m.anchor.snippet}”.` : 'Pinned to an element.')
      } else if (m.type === 'hover') {
        setHover(describeHover(m))
      } else if (m.type === 'cancel') {
        setPicking(false)
        setHover('Picking cancelled.')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [enabled, frame])

  // Which of the threads are on the file shown, keyed by their place in the list
  const onPath = anchored.flatMap((a, key) => (path && a.anchor.path === path ? [{ key, selector: a.anchor.selector, snippet: a.anchor.snippet }] : []))
  const locateKey = JSON.stringify(onPath)
  // biome-ignore lint/correctness/useExhaustiveDependencies: locateKey stands for onPath
  useEffect(() => {
    if (path) send({ type: 'locate', anchors: onPath })
  }, [path, locateKey, send])

  const status = useCallback(
    (a: AnchoredThread): PinStatus | undefined => {
      if (!path) return undefined
      if (a.anchor.path !== path) return 'elsewhere'
      const key = anchored.findIndex((x) => x.id === a.id)
      if (!located || located.path !== path || !located.pins.has(key)) return undefined
      return located.pins.get(key) ? 'shown' : 'changed'
    },
    [path, anchored, located],
  )

  const boxes = new Map<string, Box>()
  if (path && located?.path === path) {
    anchored.forEach((a, key) => {
      const rect = a.anchor.path === path ? located.pins.get(key) : null
      if (rect) boxes.set(a.id, rect)
    })
  }

  return {
    path,
    anchored,
    picking,
    draft,
    hover,
    status,
    boxes,
    startPick: () => {
      setDraft(null)
      setPicking(true)
      setHover('Choose an element on the page: click it, or use the arrow keys and press Enter. Escape cancels.')
      send({ type: 'pick' })
      // Keys go to the frame, where the helper moves between elements
      requestAnimationFrame(() => frame.current?.focus())
    },
    stopPick: () => {
      send({ type: 'stop' })
      setPicking(false)
      setHover('')
    },
    clearDraft: () => setDraft(null),
    setAnchored: setAnchoredState,
    show: (id) => {
      const key = anchored.findIndex((a) => a.id === id)
      if (key !== -1) send({ type: 'show', key })
    },
    onFrameLoad: () => send({ type: 'hello' }),
  }
}

// Numbered pins over the frame, at the elements open threads are about
export function PinLayer({ helper, onOpen }: { helper: FrameHelper; onOpen: (id: string) => void }) {
  if (helper.picking) return null
  return (
    <div className="pins">
      {helper.anchored.map((a) => {
        const box = helper.boxes.get(a.id)
        // Scrolled out of the frame
        if (!box || box.y + box.h < 0 || box.x + box.w < 0) return null
        return (
          <button
            key={a.id}
            type="button"
            className="pin"
            style={{ left: `min(calc(100% - 28px), ${Math.max(0, box.x - 12)}px)`, top: `min(calc(100% - 28px), ${Math.max(0, box.y - 12)}px)` }}
            aria-label={`Comment ${a.number}: ${a.label}`}
            onClick={() => onOpen(a.id)}
          >
            {a.number}
          </button>
        )
      })}
    </div>
  )
}

// Instructions over the frame while picking, and the way out of it
export function PickBar({ helper }: { helper: FrameHelper }) {
  if (!helper.picking) return null
  return (
    <div
      className="pickbar"
      role="group"
      aria-label="Pin a comment to an element"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        helper.stopPick()
      }}
    >
      <p>Click the part of the page this comment is about, or use the arrow keys and press Enter. Escape cancels.</p>
      <button type="button" className="button button-quiet pickbar-cancel" onClick={helper.stopPick}>
        Cancel
      </button>
    </div>
  )
}
