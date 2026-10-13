/** What the speech service reports about the read in progress. */
export type ReadAlongStatus = {
  state: 'idle' | 'loading' | 'playing' | 'paused'
  /** The mod's handle on the message being read (see `messageKey`). */
  key?: string
  label?: string
  sentence?: number
  sentences?: number
  /** The sentence being heard now. */
  text?: string
  /** Seconds heard and estimated total, both at the current speed. */
  position?: number
  total?: number
  speed?: number
  volume?: number
  /** The voice speaking the sentence heard now, as `<engine>:<name>`. */
  voice?: string
  queue: number
  error?: string | null
}

/**
 * The settings in force this session; /read-along save makes them the
 * defaults. `voices` holds one voice per group (`main`, `ja`, `he`, …), each
 * `<engine>:<name>` (kokoro:af_heart, win:Microsoft Aria) or `auto`.
 */
export type ReadAlongSettings = {
  voices: Record<string, string>
  speed: number
  /** Percent, 0 to 200. */
  volume: number
  /** Other apps' volume while reading: off, or a percent such as 30%. */
  duckOthers: string
  autoReadReplies: string
  autoReadMine: boolean
  /** With auto-read `all`, also read the thinking blocks (shown as updates in some setups). */
  readThinking: boolean
}

/** Which message is being read, and the sentence heard now. */
export type ReadAlongCursor = { key: string; text: string }

/** What this machine offers, from the speech service. */
export type ReadAlongInfo = {
  platform: 'wsl' | 'linux' | 'macos' | 'windows'
  engines: { name: string; label: string; ok: boolean }[]
  player: string | null
  /** Whether other apps can be turned down while reading (WSL only for now). */
  canDuck: boolean
  /** The voice `auto` picks for the main group here. */
  auto: string | null
  /** The language of Latin-script text. */
  mainLanguage: string
  /** The languages each non-main group covers. */
  groupLangs: Record<string, string[]>
}

/** An installed voice. */
/** `own`: a Pocket TTS voice from the person's own folder. */
export type ReadAlongVoice = { id: string; name: string; lang: string; engine: string; own?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'read-along': {
      now: ReadAlongStatus | null
      prefs: ReadAlongSettings | null
      cursor: ReadAlongCursor | null
      info: ReadAlongInfo | null
      /** The voice group whose full list the settings pane shows. */
      browsing: string | null
      voices: ReadAlongVoice[] | null
      /** Bumped to redraw only the band and the hint line, for the check that another mod hides the band. */
      bandCheck: number
    }
  }
}
