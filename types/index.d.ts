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
  voice?: string
  queue: number
  error?: string | null
}

/** The settings in force this session; /read-along save makes them the defaults. A voice is a Kokoro name (af_heart) or `win:<Windows voice>`. */
export type ReadAlongSettings = {
  voice: string
  voices: string[]
  jaVoice: string
  jaVoices: string[]
  heVoice: string
  heVoices: string[]
  speed: number
  /** Percent, 0 to 200. */
  volume: number
  /** Other apps' volume while reading: off, or a percent such as 30%. */
  duckOthers: string
  autoReadReplies: string
  autoReadMine: boolean
}

/** Which message is being read, and the sentence heard now. */
export type ReadAlongCursor = { key: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'read-along': {
      now: ReadAlongStatus | null
      prefs: ReadAlongSettings | null
      cursor: ReadAlongCursor | null
    }
  }
}
