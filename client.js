/*
 * Copyright 2026 white-77
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser half of the Read Aloud bundle.
 *
 * Two additive surfaces over the shipped UI:
 *  - a speaker action in `conversation.chat.assistant-actions` (one per
 *    finalized assistant reply) that speaks the reply with the browser's
 *    speech synthesis and turns into an animated stop control while playing;
 *  - one row in `settings.general.item` for voice and speed, persisted in
 *    localStorage.
 *
 * Everything stays inside the host's flow: the action row is the host's own
 * row (our entry lands in its `extraActions` seat), the settings row copies the
 * host's General row pattern, and only `--dsw-alias-*` theme tokens are used.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-read-aloud',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'read-aloud'
    /** localStorage key for the voice/speed preference. */
    const PREFS_KEY = 'dsh-read-aloud:prefs'
    /** Pseudo message id used by the settings preview button. */
    const PREVIEW_ID = '__read-aloud-preview__'
    /** Upper bound for one utterance; longer text is split into more chunks. */
    const MAX_CHUNK = 180

    /**
     * Host routes, always relative: the Desktop document origin is `dsh-app://app`
     * and the shell forwards non-static paths to the Host, while in the Web GUI
     * the document origin already is the Host. An absolute origin would turn
     * these reads into cross-origin requests the Desktop renderer blocks.
     */
    const HOST_VOICES_PATH = '/api/dsh-read-aloud/voices'
    const HOST_SPEECH_PATH = '/api/dsh-read-aloud/speech'
    /** Streaming PCM endpoint, used for the offline voices. */
    const HOST_STREAM_PATH = '/api/dsh-read-aloud/stream'

    /** How long the neural voice catalogue is trusted before a refetch. */
    const VOICE_CACHE_MS = 15000

    const zh = {
      'action.read': '朗读',
      'action.stop': '停止朗读',
      'action.unsupported': '当前环境不支持语音合成',
      'settings.title': '朗读',
      'settings.description': '用系统语音朗读助手回复，可调整音色与语速',
      'settings.descriptionNeural': '用离线神经音色朗读助手回复（已安装 {count} 个音色）；英文单词由系统音色朗读，可调整语速',
      'settings.unsupported': '当前环境不支持语音合成，朗读按钮不会出现。',
      'settings.groupNeural': '离线音色（快速）',
      'settings.groupNeuralSlow': 'Kokoro 多语言（较慢，可中英混读）',
      'settings.groupCloud': '云端音色（需联网）',
      'settings.groupSystem': '系统音色',
      'settings.groupSystemOnly': '系统音色（未安装离线模型）',
      'settings.voice': '音色',
      'settings.voiceDefault': '自动选择（优先离线音色）',
      'settings.voiceNone': '系统没有上报可用音色，将按默认语言朗读',
      'settings.rate': '语速',
      'settings.mode': '自动朗读',
      'settings.modeHint': '设置哪种自动朗读方式；切换在下一轮生效',
      'settings.modeFinal': '每轮完成',
      'settings.modeStream': '边生成边读',
      'auto.on': '自动朗读：开（本会话）',
      'auto.off': '自动朗读：关（点击开启）',
      'settings.preview': '试听',
      'settings.previewStop': '停止试听',
      'settings.previewText': '你好，我是语音朗读。我会把助手的回复读给你听，语速和音色都可以在设置里调整。',
      'settings.error': '朗读失败：{message}',
    }

    const en = {
      'action.read': 'Read aloud',
      'action.stop': 'Stop reading',
      'action.unsupported': 'Speech synthesis is unavailable in this environment',
      'settings.title': 'Read aloud',
      'settings.description': 'Read assistant replies with the system voice; pick a voice and a speed.',
      'settings.descriptionNeural': 'Read assistant replies with offline neural voices ({count} installed); English words use the system voice. Speed is adjustable.',
      'settings.unsupported': 'Speech synthesis is unavailable here, so no speaker action is shown.',
      'settings.groupNeural': 'Offline voices (fast)',
      'settings.groupNeuralSlow': 'Kokoro multilingual (slower, mixed zh/en)',
      'settings.groupCloud': 'Cloud voices (needs network)',
      'settings.groupSystem': 'System voices',
      'settings.groupSystemOnly': 'System voices (no offline model installed)',
      'settings.voice': 'Voice',
      'settings.voiceDefault': 'Automatic (prefer an offline voice)',
      'settings.voiceNone': 'The system reported no voices; speech uses the default language',
      'settings.rate': 'Speed',
      'settings.mode': 'Auto read',
      'settings.modeHint': 'How automatic reading works; a change applies from the next turn',
      'settings.modeFinal': 'After each turn',
      'settings.modeStream': 'While streaming',
      'auto.on': 'Auto read: on (this session)',
      'auto.off': 'Auto read: off (click to enable)',
      'settings.preview': 'Preview',
      'settings.previewStop': 'Stop preview',
      'settings.previewText': 'Hello. I can read assistant replies aloud. Voice and speed are adjustable in settings.',
      'settings.error': 'Could not read aloud: {message}',
    }

    const CSS = `
.dra-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition: color 0.12s ease, background-color 0.12s ease;
}
.dra-action svg {
  width: calc(16px + var(--dsh-content-font-delta, 0px));
  height: calc(16px + var(--dsh-content-font-delta, 0px));
}
.dra-action:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-secondary);
}
.dra-action:focus-visible {
  outline: 1.5px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 2px;
}
.dra-action--active {
  color: var(--dsw-alias-brand-primary);
}
.dra-action--active:hover {
  color: var(--dsw-alias-brand-primary);
}
.dra-eq {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2.5px;
  height: 14px;
}
.dra-eq i {
  display: block;
  width: 2.5px;
  height: 100%;
  border-radius: 2px;
  background: currentColor;
  transform-origin: center;
  animation: dra-eq 900ms ease-in-out infinite;
}
@keyframes dra-eq {
  0%, 100% { transform: scaleY(0.35); }
  50% { transform: scaleY(1); }
}
@media (prefers-reduced-motion: reduce) {
  .dra-eq i { animation: none; transform: scaleY(0.7); }
}
.dra-item {
  display: block;
}
/*
 * Two stacked bands, not a left/right pair: three controls (voice select,
 * speed slider, preview) do not fit beside the copy inside the settings panel,
 * and a side-by-side row squeezes the description to one character per line.
 */
.dra-row {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dra-text {
  min-width: 0;
}
.dra-title {
  font-size: 14px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dra-description {
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dra-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  min-width: 0;
}
.dra-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dra-header {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-md, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  flex: none;
}
.dra-header:hover {
  background: var(--dsw-alias-bg-l2);
  color: var(--dsw-alias-label-primary);
}
.dra-header--on {
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary));
}
.dra-select--mode {
  flex: 0 1 116px;
  min-width: 96px;
  max-width: 116px;
}
.dra-controls--auto {
  margin-top: 2px;
}
.dra-field--voice {
  flex: 0 1 auto;
  min-width: 0;
}
.dra-field-label {
  color: var(--dsw-alias-label-secondary);
  flex: none;
}
.dra-select {
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 4px 6px;
  /* Keeps select + slider + preview on one line inside the 564px content column. */
  flex: 0 1 168px;
  min-width: 108px;
  max-width: 168px;
  cursor: pointer;
}
.dra-select:focus-visible {
  outline: 1.5px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
.dra-range {
  width: 88px;
  flex: none;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.dra-rate {
  min-width: 34px;
  flex: none;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}
.dra-button {
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 3px 12px;
  flex: none;
  margin-left: auto;
  cursor: pointer;
}
.dra-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}
.dra-button:focus-visible {
  outline: 1.5px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
.dra-error {
  margin: 6px 0 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}
`

    // ---------------------------------------------------------------------
    // Tiny reactive store (getSnapshot/subscribe for React, set for writers)
    // ---------------------------------------------------------------------

    /**
     * Create a minimal observable snapshot store.
     * @param {object} initial - first snapshot.
     * @returns {{ getSnapshot: () => object, subscribe: (fn: () => void) => () => void, set: (patch: object) => void }}
     */
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(patch) {
          const next = Object.assign({}, state, patch)
          if (Object.keys(patch).every((key) => Object.is(next[key], state[key]))) return
          state = next
          for (const listener of Array.from(listeners)) {
            try {
              listener()
            } catch (error) {
              /* a broken subscriber must not break playback */
            }
          }
        },
      }
    }

    /**
     * Subscribe a component to a store snapshot.
     * @param {{ getSnapshot: () => object, subscribe: Function }} store - any store made by createStore.
     * @returns {object} latest snapshot.
     */
    function useStore(store) {
      const [snapshot, setSnapshot] = React.useState(() => store.getSnapshot())
      React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store])
      return snapshot
    }

    // ---------------------------------------------------------------------
    // Speech text preparation (markdown -> speakable plain text)
    // ---------------------------------------------------------------------

    /**
     * Rewrite markdown table rows as speakable sentences.
     *
     * Table rows used to be replaced with a space, which discarded every cell:
     * a reply whose actual data lived in a table was read as if the table were
     * not there, and a reply *ending* in a table stopped being read at that
     * point. Each row now becomes one sentence — `cell，cell，cell。` — and the
     * separator row (`|---|---|`), which carries no text, is dropped.
     * @param {string} markdown - text that may contain table rows.
     * @returns {string} same text with tables turned into sentences.
     */
    function tablesToSpeech(markdown) {
      const lines = markdown.split('\n')
      const out = []
      let table = []
      const flush = () => {
        for (const row of table) {
          const cells = row
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((cell) => cell.trim())
            .filter((cell) => cell.length > 0)
          if (cells.length === 0) continue
          /* A separator row is nothing but dashes and colons. */
          if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue
          out.push(cells.join('，') + '。')
        }
        table = []
      }
      for (const line of lines) {
        if (/^\s*\|.*\|\s*$/.test(line)) {
          table.push(line)
          continue
        }
        flush()
        out.push(line)
      }
      flush()
      return out.join('\n')
    }

    /**
     * Strip markdown syntax and code so the reader speaks the prose, not the markup.
     * @param {string} markdown - assistant reply text.
     * @returns {string} speakable text.
     */
    function toSpeechText(markdown) {
      if (typeof markdown !== 'string' || markdown.length === 0) return ''
      let text = markdown
      text = text.replace(/```[\s\S]*?(?:```|$)/g, ' ')
      text = text.replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
      text = text.replace(/`([^`\n]*)`/g, '$1')
      text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      text = text.replace(/<[^>]+>/g, ' ')
      text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
      text = text.replace(/^\s{0,3}>\s?/gm, '')
      text = tablesToSpeech(text)
      text = text.replace(/^\s*[-*+]\s+/gm, '')
      text = text.replace(/^\s*\d+[.)]\s+/gm, '')
      text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ')
      text = text.replace(/[*_~]{1,3}/g, '')
      text = text.replace(/[ \t\u00a0]+/g, ' ')
      text = text.replace(/\s*\n\s*/g, ' ')
      return text.trim()
    }

    /**
     * Split text into sentence-ish units, keeping the terminal punctuation.
     * @param {string} text - plain text.
     * @returns {string[]} sentences.
     */
    function splitSentences(text) {
      const out = []
      let buffer = ''
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        buffer += char
        const cnEnd = '。！？；…'.indexOf(char) !== -1
        const enEnd = (char === '.' || char === '!' || char === '?')
          && (index + 1 >= text.length || /\s/.test(text[index + 1]))
        if ((cnEnd || enEnd) && buffer.trim().length > 0) {
          out.push(buffer.trim())
          buffer = ''
        }
      }
      if (buffer.trim().length > 0) out.push(buffer.trim())
      return out
    }

    /**
     * Join two sentence fragments with a space when both sides are Latin text,
     * so English sentences do not run together ("here.Second"). CJK text needs
     * no separator, and a Latin fragment after CJK punctuation gets one.
     * @param {string} left - accumulated text.
     * @param {string} right - next fragment.
     * @returns {string} joined text.
     */
    function joinFragment(left, right) {
      if (left.length === 0) return right
      const leftLatin = /[A-Za-z0-9]$/.test(left) || /[A-Za-z0-9][.!?;:,]$/.test(left)
      const leftCjkEnd = /[\u3002\uff01\uff1f\uff1b\u2026]$/.test(left)
      const rightLatin = /^[A-Za-z0-9]/.test(right)
      const needsSpace = rightLatin && (leftLatin || leftCjkEnd)
      return needsSpace ? left + ' ' + right : left + right
    }

    /**
     * Split speakable text into utterance-sized chunks.
     * @param {string} text - plain text.
     * @param {number} [max] - maximum chunk length.
     * @returns {string[]} chunks ready for SpeechSynthesisUtterance.
     */
    function chunkText(text, max = MAX_CHUNK) {
      const chunks = []
      let current = ''
      for (const sentence of splitSentences(text)) {
        if (sentence.length > max) {
          if (current.length > 0) {
            chunks.push(current)
            current = ''
          }
          for (let offset = 0; offset < sentence.length; offset += max) {
            chunks.push(sentence.slice(offset, offset + max))
          }
          continue
        }
        if (current.length > 0 && current.length + sentence.length > max) {
          chunks.push(current)
          current = sentence
        } else {
          current = joinFragment(current, sentence)
        }
      }
      if (current.trim().length > 0) chunks.push(current.trim())
      return chunks.filter((chunk) => chunk.trim().length > 0)
    }

    /** Matches a CJK character, which the Chinese neural models can pronounce. */
    const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

    /** Matches a Latin letter, which the Chinese neural models cannot pronounce. */
    const LATIN_CHAR = /[A-Za-z]/

    /**
     * Split text into runs by script.
     *
     * Punctuation, spaces and digits are neutral: they stay inside whichever run
     * they touch, so "12340 kWh" keeps its number with the surrounding text and
     * the model's number rule still applies.
     * @param {string} text - speakable text.
     * @returns {{ kind: 'cjk' | 'latin', text: string }[]} script runs.
     */
    function segmentByScript(text) {
      const segments = []
      let kind = null
      let buffer = ''
      const flush = () => {
        if (buffer.length === 0) return
        segments.push({ kind: kind === 'latin' ? 'latin' : 'cjk', text: buffer })
        buffer = ''
      }
      for (const char of text) {
        if (!CJK_CHAR.test(char) && !LATIN_CHAR.test(char)) {
          buffer += char
          continue
        }
        const charKind = CJK_CHAR.test(char) ? 'cjk' : 'latin'
        if (kind === null) {
          kind = charKind
          buffer += char
          continue
        }
        if (charKind === kind) {
          buffer += char
          continue
        }
        flush()
        kind = charKind
        buffer = char
      }
      flush()
      return segments
    }

    /**
     * Best installed English system voice.
     *
     * The neural models are Chinese-only (pinyin lexicon), so English words are
     * out-of-vocabulary and the engine drops them, returning near-silence. Latin
     * runs are therefore read by the browser voice, which does have English.
     * @returns {SpeechSynthesisVoice | null} an English voice, or null.
     */
    function pickEnglishVoice() {
      const voices = safeVoices()
      return (
        voices.find((voice) => /^en[-_]?US/i.test(voice.lang || '')) ||
        voices.find((voice) => /^en/i.test(voice.lang || '')) ||
        null
      )
    }

    /** CJK punctuation, which an English voice should not be asked to read. */
    const CJK_PUNCTUATION = /^[\s\u3000-\u303f\uff00-\uffef]+|[\s\u3000-\u303f\uff00-\uffef]+$/g

    /**
     * Build engine-tagged chunks for one reading.
     *
     * Chinese runs use the neural voice. Latin runs use the system voice, because
     * a Chinese neural model silently swallows them. When the browser has no
     * synthesizer at all, everything stays on the neural voice rather than
     * dropping the Latin text.
     * @param {string} text - speakable text.
     * @param {object | null} neuralVoice - resolved neural voice, or null when reading is system-only.
     * @param {boolean} canSystem - whether the browser offers a speech synthesizer.
     * @returns {{ engine: 'neural' | 'system', text: string, voiceId?: string, english?: boolean }[]} items.
     */
    function buildSpeechItems(text, neuralVoice, canSystem) {
      const items = []
      const add = (source, make) => {
        for (const chunk of chunkText(source)) items.push(make(chunk))
      }
      if (neuralVoice === null) {
        add(text, (chunk) => ({ engine: 'system', text: chunk }))
        return items
      }
      const engineKind = neuralVoice.kind === 'cloud' ? 'cloud' : 'neural'
      const neural = (source) =>
        add(source, (chunk) => ({ engine: engineKind, text: chunk, voiceId: neuralVoice.id, sid: neuralVoice.sid ?? 0 }))
      /* A multilingual pack pronounces both scripts itself, so splitting would
         only cost extra requests on an already slow engine. */
      if (!canSystem || neuralVoice.multilingual === true || engineKind === 'cloud') {
        neural(text)
        return items
      }
      for (const segment of segmentByScript(text)) {
        if (segment.kind === 'latin') {
          /* Chinese punctuation around a Latin run comes from the CJK side; the
             utterance boundary already supplies the pause, so drop it here. */
          const cleaned = segment.text.replace(CJK_PUNCTUATION, '').trim()
          if (cleaned.length === 0) continue
          add(cleaned, (chunk) => ({ engine: 'system', text: chunk, english: true }))
        } else {
          neural(segment.text)
        }
      }
      return items
    }

    /**
     * Convert an assistant reply's content blocks into speakable text.
     *
     * The Chat snapshot already carries the finalized reply: the Turn tail's
     * `closing` is the last Assistant step with visible text, and the action
     * row is keyed by that step's durable message id. A selector returns a
     * plain string, so the hook's snapshot comparison stays stable. The scan is
     * the same one the Host's own Chat layer performs for a Turn tail.
     * @param {object} snapshot - Chat snapshot from the slot's `useChat` hook.
     * @param {string} messageId - durable assistant message id.
     * @returns {string} reply text, or an empty string when it is not loaded.
     */
    function replyTextOf(snapshot, messageId) {
      if (snapshot === null || typeof snapshot !== 'object') return ''
      const turns = snapshot.timeline && snapshot.timeline.turns
      if (turns === undefined || typeof turns.values !== 'function') return ''
      try {
        for (const turn of turns.values()) {
          const tail = turn && turn.data && typeof turn.data.get === 'function'
            ? turn.data.get('turn-tail')
            : undefined
          const closing = tail && tail.closing
          const finalNode = closing && closing.finalNode
          if (!finalNode || String(finalNode.messageId) !== String(messageId)) continue
          const blocks = Array.isArray(closing.blocks) ? closing.blocks : []
          return blocks
            .filter((block) => block && block.kind === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
        }
      } catch (error) {
        return ''
      }
      return ''
    }

    // ---------------------------------------------------------------------
    // Speech engine
    // ---------------------------------------------------------------------

    /** @returns {SpeechSynthesis | null} the browser's speech synthesizer. */
    function getSynthesizer() {
      if (typeof window === 'undefined') return null
      const synth = window.speechSynthesis
      return synth && typeof synth.speak === 'function' ? synth : null
    }

    /** @returns {SpeechSynthesisVoice[]} available voices, newest list. */
    function safeVoices() {
      const synth = getSynthesizer()
      if (synth === null || typeof synth.getVoices !== 'function') return []
      try {
        const voices = synth.getVoices()
        return Array.isArray(voices) ? voices : []
      } catch (error) {
        return []
      }
    }

    /**
     * Order voices for the picker: Chinese first, then the rest.
     * @returns {SpeechSynthesisVoice[]} ordered voices.
     */
    function voiceOptions() {
      const voices = safeVoices()
      const chinese = voices.filter((voice) => /^zh/i.test(voice.lang || ''))
      const others = voices.filter((voice) => !/^zh/i.test(voice.lang || ''))
      return chinese.concat(others)
    }

    /**
     * Trim a platform voice name to the part people recognise.
     *
     * Windows reports names such as "Microsoft Huihui - Chinese (Simplified,
     * PRC)"; the locale is already shown beside it, and the full string does
     * not fit the select inside the settings column.
     * @param {SpeechSynthesisVoice} voice - browser voice.
     * @returns {string} short display name.
     */
    function shortVoiceName(voice) {
      const raw = String((voice && (voice.name || voice.voiceURI)) || '')
      const base = raw.split(' - ')[0].replace(/\s*\([^)]*\)\s*/g, ' ').trim() || raw
      return base.replace(/^Microsoft\s+/i, '').replace(/\s+Desktop$/i, '').trim() || raw
    }

    /**
     * Compact language tag for a voice: Chinese voices read as 中文 (or 繁體).
     * @param {SpeechSynthesisVoice} voice - browser voice.
     * @returns {string} language tag.
     */
    function langTag(voice) {
      const lang = String((voice && voice.lang) || '')
      if (/^zh/i.test(lang)) return /TW|HK|Hant/i.test(lang) ? '繁體' : '中文'
      if (lang.length === 0) return '—'
      return lang.replace('_', '-')
    }

    /**
     * Clamp a numeric preference.
     * @param {unknown} value - stored value.
     * @param {number} min - lower bound.
     * @param {number} max - upper bound.
     * @param {number} fallback - value used when the stored value is unusable.
     * @returns {number} clamped number.
     */
    function clampNumber(value, min, max, fallback) {
      const number = typeof value === 'number' ? value : Number.parseFloat(String(value))
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, number))
    }

    /**
     * Resolve the system voice and speed used by the next utterance.
     * @param {{ voice?: string, rate?: number }} prefs - stored preferences.
     * @param {string} [wantedName] - system voice name already chosen by the caller.
     * @returns {{ voice: SpeechSynthesisVoice | null, lang: string, rate: number }} utterance options.
     */
    function resolveOptions(prefs, wantedName) {
      const voices = safeVoices()
      const wanted = typeof wantedName === 'string' ? wantedName : ''
      let voice = wanted.length > 0 ? findVoice(voices, wanted) : undefined
      if (voice === undefined) voice = voices.find((candidate) => /^zh[-_]?CN/i.test(candidate.lang || ''))
      if (voice === undefined) voice = voices.find((candidate) => /^zh/i.test(candidate.lang || ''))
      return {
        voice: voice || null,
        lang: (voice && voice.lang) || 'zh-CN',
        rate: clampNumber(prefs && prefs.rate, 0.5, 2, 1),
      }
    }

    /**
     * Match a stored voice name against the live list.
     *
     * Browsers that expose several variants of one voice ("Microsoft Huihui" vs
     * "Microsoft Huihui Desktop") report different names per engine, so an exact
     * miss falls back to the same voice name or the same voiceURI. A stored
     * preference is otherwise silently replaced by the default voice.
     * @param {SpeechSynthesisVoice[]} voices - live voice list.
     * @param {string} wanted - stored name or voiceURI.
     * @returns {SpeechSynthesisVoice | undefined} the matching voice.
     */
    function findVoice(voices, wanted) {
      const exact = voices.find((candidate) => candidate.name === wanted)
      if (exact !== undefined) return exact
      const byUri = voices.find((candidate) => candidate.voiceURI === wanted)
      if (byUri !== undefined) return byUri
      const target = shortVoiceName({ name: wanted })
      if (target.length === 0) return undefined
      return voices.find((candidate) => shortVoiceName(candidate) === target)
    }

    // ---------------------------------------------------------------------
    // Voice catalogue: Host neural voices + browser system voices
    // ---------------------------------------------------------------------

    /** Preference prefix selecting a Host neural voice. */
    const NEURAL_PREFIX = 'neural:'

    /** Preference prefix selecting a browser system voice. */
    const SYSTEM_PREFIX = 'system:'

    /**
     * Split a stored preference into its engine and voice part.
     * @param {string} stored - `''`, `neural:<id>`, or `system:<name>`.
     * @returns {{ kind: 'auto' | 'neural' | 'system', value: string }} the parts.
     */
    function parseVoicePref(stored) {
      const text = typeof stored === 'string' ? stored : ''
      if (text.startsWith(NEURAL_PREFIX)) return { kind: 'neural', value: text.slice(NEURAL_PREFIX.length) }
      if (text.startsWith(SYSTEM_PREFIX)) return { kind: 'system', value: text.slice(SYSTEM_PREFIX.length) }
      return { kind: 'auto', value: '' }
    }

    /**
     * Read the Host's installed neural voices.
     * @returns {Promise<{ available: boolean, engine: string, reason: string | null, voices: object[] }>}
     */
    async function loadHostVoices() {
      try {
        const response = await fetch(HOST_VOICES_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) return { available: false, engine: 'system', reason: 'Host 未响应', voices: [] }
        const payload = await response.json()
        const value = payload && payload.value ? payload.value : {}
        return {
          available: value.available === true,
          engine: typeof value.engine === 'string' ? value.engine : 'system',
          reason: typeof value.reason === 'string' ? value.reason : null,
          voices: Array.isArray(value.voices) ? value.voices : [],
        }
      } catch (error) {
        return { available: false, engine: 'system', reason: 'Host 未响应', voices: [] }
      }
    }

    /**
     * Expand the Host catalogue into the flat list the picker shows.
     *
     * A single-speaker pack is one entry. A multi-speaker pack (Kokoro) is one
     * entry per speaker, so picking a specific speaker stays one click away
     * instead of hiding behind a second selector.
     * @param {object[]} manifests - voice manifests from the Host.
     * @returns {object[]} entries `{ key, id, sid, label, language, license, engine }`.
     */
    function flattenVoices(manifests) {
      const entries = []
      for (const voice of manifests) {
        const speakers = Array.isArray(voice.speakers) ? voice.speakers : null
        if (speakers === null || speakers.length === 0) {
          entries.push({
            key: voice.id,
            id: voice.id,
            sid: 0,
            label: voice.label,
            language: voice.language,
            license: voice.license,
            engine: voice.engine,
            slow: voice.slow === true,
            multilingual: voice.engine === 'kokoro' || voice.engine === 'matcha',
          })
          continue
        }
        for (const speaker of speakers) {
          const sid = typeof speaker.sid === 'number' ? speaker.sid : Number.parseInt(String(speaker.sid), 10)
          if (!Number.isInteger(sid)) continue
          const name = typeof speaker.label === 'string' && speaker.label.length > 0
            ? speaker.label
            : String(speaker.name || '#' + sid)
          entries.push({
            key: voice.id + '@' + sid,
            id: voice.id,
            sid,
            label: name,
            language: typeof speaker.language === 'string' ? speaker.language : voice.language,
            license: voice.license,
            engine: voice.engine,
            slow: voice.slow === true,
            multilingual: voice.engine === 'kokoro' || voice.engine === 'matcha',
          })
        }
      }
      return entries
    }

    /**
     * Resolve which engine and voice the next utterance uses.
     *
     * An explicit choice always wins. Only the `auto` state (no stored voice)
     * prefers a neural voice, because otherwise installing a neural pack would
     * make every system voice silently unreachable: the picker would jump back
     * to the first neural entry as soon as one was selected.
     * @param {string} stored - stored preference.
     * @param {object[]} entries - flattened catalogue entries.
     * @returns {{ kind: 'neural' | 'cloud' | 'system', key?: string, id?: string, sid?: number, label?: string, name?: string }} resolved voice.
     */
    function resolveVoice(stored, entries) {
      const preference = parseVoicePref(stored)
      const describe = (entry) => ({
        kind: entry.engine === 'cloud' ? 'cloud' : 'neural',
        key: entry.key,
        id: entry.id,
        sid: entry.sid,
        label: entry.label,
        multilingual: entry.multilingual === true,
      })
      if (preference.kind === 'system') {
        /* The chosen ENGINE always wins, even if the named voice is gone or the
           list has not loaded yet: dropping to a neural voice here would undo
           the user's choice, and `resolveOptions` already falls back to the
           default Chinese system voice for an unknown name. */
        if (preference.value === '') return { kind: 'system', name: '' }
        const match = findVoice(safeVoices(), preference.value)
        return { kind: 'system', name: match !== undefined ? match.name : '' }
      }
      if (preference.kind === 'neural') {
        const match = entries.find((voice) => voice.key === preference.value)
        if (match !== undefined) return describe(match)
      }
      if (entries.length > 0) return describe(entries[0])
      return { kind: 'system', name: '' }
    }

    /**
     * Create the single playback owner: one reply at a time, cancellable from
     * anywhere (the action button, the settings preview, plugin disposal).
     * @returns {object} player with store / speak / stop / dispose.
     */
    function createPlayer() {
      const synth = getSynthesizer()
      const store = createStore({
        messageId: null,
        playing: false,
        chunkIndex: 0,
        chunkCount: 0,
        engine: null,
        error: null,
      })
      let utterances = []
      let timers = []
      /** @type {AbortController | null} */
      let fetchAbort = null
      /** @type {HTMLAudioElement | null} */
      let audio = null
      /** @type {string | null} */
      let audioUrl = null
      let token = 0
      let disposed = false
      /** @type {object | null} clock of the audio currently scheduled. */
      let playbackTimeline = null

      const clearTimers = () => {
        for (const timer of timers) window.clearTimeout(timer)
        timers = []
      }

      const releaseAudio = () => {
        if (audio !== null) {
          try {
            audio.pause()
            audio.src = ''
          } catch (error) {
            /* element already torn down */
          }
          audio = null
        }
        if (audioUrl !== null) {
          try {
            window.URL.revokeObjectURL(audioUrl)
          } catch (error) {
            /* not an object URL */
          }
          audioUrl = null
        }
      }

      /**
       * Lazily create the shared AudioContext for streamed PCM.
       *
       * A click starts playback, so the context is allowed to run; a context
       * created earlier can still be suspended by autoplay policy, hence the
       * resume call.
       * @param {object} timeline - playback clock to attach the context to.
       * @returns {AudioContext | null} the context, or null when unavailable.
       */
      const ensureAudioContext = (timeline) => {
        if (timeline.context !== null) return timeline.context
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (typeof Ctor !== 'function') return null
        try {
          timeline.context = new Ctor()
        } catch (error) {
          return null
        }
        if (timeline.context.state === 'suspended' && typeof timeline.context.resume === 'function') {
          timeline.context.resume().catch(() => undefined)
        }
        return timeline.context
      }

      /**
       * Append one PCM fragment to the playback timeline.
       *
       * Fragments are queued back to back; a small lead absorbs jitter when
       * synthesis briefly falls behind real time.
       * @param {object} timeline - playback clock.
       * @param {Float32Array} samples - mono samples in [-1, 1].
       * @param {number} sampleRate - sample rate in Hz.
       */
      const scheduleSamples = (timeline, samples, sampleRate) => {
        const context = timeline.context
        if (context === null || samples.length === 0) return
        const buffer = context.createBuffer(1, samples.length, sampleRate)
        buffer.copyToChannel(samples, 0)
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        const at = Math.max(timeline.nextAt, context.currentTime + 0.12)
        source.start(at)
        timeline.nextAt = at + buffer.duration
        timeline.endAt = timeline.nextAt
        timeline.sources.add(source)
        source.onended = () => timeline.sources.delete(source)
      }

      /**
       * Resolve once everything scheduled on the timeline has been heard.
       * @param {object} timeline - playback clock.
       * @param {AbortController} controller - aborts the wait on stop.
       * @returns {Promise<void>} resolves when playback drains or is cancelled.
       */
      const waitForTimeline = (timeline, controller) => new Promise((resolve) => {
        const context = timeline.context
        if (context === null) {
          resolve()
          return
        }
        const deadline = Date.now() + 300000
        const poll = () => {
          if (controller.signal.aborted || timeline.sources.size === 0) {
            resolve()
            return
          }
          if (context.currentTime >= timeline.endAt || Date.now() > deadline) {
            resolve()
            return
          }
          window.setTimeout(poll, 60)
        }
        poll()
      })

      /**
       * Stop and forget every source scheduled on the current timeline.
       * @param {object | null} timeline - playback clock to drain.
       */
      const stopTimeline = (timeline) => {
        if (timeline === null) return
        for (const source of Array.from(timeline.sources)) {
          try {
            source.stop()
          } catch (error) {
            /* already stopped */
          }
        }
        timeline.sources.clear()
        timeline.nextAt = 0
        timeline.endAt = 0
      }

      const reset = (error) => {
        utterances = []
        fetchAbort = null
        releaseAudio()
        store.set({
          playing: false,
          messageId: null,
          chunkIndex: 0,
          chunkCount: 0,
          engine: null,
          error: error || null,
        })
      }

      const stop = () => {
        token += 1
        if (playbackTimeline !== null) {
          stopTimeline(playbackTimeline)
          playbackTimeline = null
        }
        clearTimers()
        if (fetchAbort !== null) {
          try {
            fetchAbort.abort()
          } catch (error) {
            /* already aborted */
          }
          fetchAbort = null
        }
        if (synth !== null) {
          try {
            synth.cancel()
          } catch (error) {
            /* nothing to cancel */
          }
        }
        const state = store.getSnapshot()
        if (state.playing || state.error !== null) reset(null)
        else releaseAudio()
      }

      /**
       * Speak one chunk with the browser's system voice.
       * @param {{ text: string, english?: boolean }} item - one chunk.
       * @param {object} options - resolved { voice, lang } for non-English chunks.
       * @param {number} rate - speed multiplier.
       * @returns {Promise<void>} resolves when the utterance finishes.
       */
      const speakSystemItem = (item, options, rate) => new Promise((resolve, reject) => {
        if (synth === null) {
          reject(new Error('系统语音不可用'))
          return
        }
        let utterance
        try {
          utterance = new SpeechSynthesisUtterance(item.text)
        } catch (error) {
          reject(new Error('speech-unsupported'))
          return
        }
        const englishVoice = item.english === true ? pickEnglishVoice() : null
        if (item.english === true && englishVoice === null) {
          /* No English voice installed: a Chinese voice would emit near-silence
             here, so skip this chunk instead of playing a silent gap. */
          resolve()
          return
        }
        if (englishVoice !== null) {
          utterance.voice = englishVoice
          utterance.lang = englishVoice.lang
        } else {
          if (options.voice !== null) utterance.voice = options.voice
          utterance.lang = options.lang
        }
        utterance.rate = rate
        utterance.volume = 1
        utterance.onend = () => resolve()
        utterance.onerror = (event) => {
          const reason = event && event.error ? String(event.error) : 'speech-error'
          /* cancel() reports these two; they are not failures. */
          if (reason === 'interrupted' || reason === 'canceled') resolve()
          else reject(new Error(reason))
        }
        utterances.push(utterance)
        try {
          synth.speak(utterance)
        } catch (error) {
          reject(new Error('speech-error'))
        }
      })

      /**
       * Ask the Host to synthesize one neural chunk.
       * @param {{ text: string, voiceId: string, sid: number }} item - one chunk.
       * @param {number} rate - speed multiplier.
       * @param {AbortController} controller - cancels the request on stop.
       * @returns {Promise<Blob>} WAV audio.
       */
      const synthesizeItem = async (item, rate, controller) => {
        const response = await fetch(HOST_SPEECH_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: item.text, voice: item.voiceId, sid: item.sid, rate }),
          signal: controller.signal,
        })
        if (!response.ok) {
          let detail = ''
          try {
            const payload = await response.json()
            detail = payload && payload.error && payload.error.message ? String(payload.error.message) : ''
          } catch (error) {
            detail = ''
          }
          if (detail.length > 0) throw new Error(detail)
          if (response.status === 503) throw new Error('神经音色引擎不可用')
          if (response.status === 404) throw new Error('音色模型未安装')
          if (response.status === 413) throw new Error('这段文本太长，无法一次朗读')
          throw new Error('合成失败 (' + response.status + ')')
        }
        return response.blob()
      }

      /**
       * Play one synthesized WAV blob.
       * @param {Blob} blob - WAV bytes.
       * @returns {Promise<void>} resolves when playback ends.
       */
      const playBlob = (blob) => new Promise((resolve, reject) => {
        releaseAudio()
        const element = new window.Audio()
        audioUrl = window.URL.createObjectURL(blob)
        element.src = audioUrl
        element.playbackRate = 1
        element.onended = () => resolve()
        element.onerror = () => reject(new Error('音频播放失败'))
        audio = element
        const started = element.play()
        if (started && typeof started.catch === 'function') started.catch(() => reject(new Error('音频播放被拦截')))
      })

      /**
       * Read a framed PCM stream from the Host and schedule it for playback as
       * fragments arrive.
       *
       * Frame layout: magic `DRS1`, uint32 sample rate, uint32 format, then
       * repeated { uint32 byteLength, int16 samples }. Scheduling each fragment
       * on one timeline means the first words play while the rest is still being
       * synthesized.
       * @param {object} item - one engine-tagged chunk.
       * @param {number} rate - speed multiplier.
       * @param {AbortController} controller - cancels the request on stop.
       * @param {object} timeline - shared playback clock `{ nextAt, sources, context }`.
       * @returns {Promise<void>} resolves when this chunk's audio has all played.
       */
      const playPcmStream = async (item, rate, controller, timeline) => {
        const response = await fetch(HOST_STREAM_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: item.text, voice: item.voiceId, sid: item.sid, rate }),
          signal: controller.signal,
        })
        if (!response.ok) {
          let detail = ''
          try {
            const payload = await response.json()
            detail = payload && payload.error && payload.error.message ? String(payload.error.message) : ''
          } catch (error) {
            detail = ''
          }
          throw new Error(detail || '流式合成失败 (' + response.status + ')')
        }
        const reader = response.body.getReader()
        let pending = new Uint8Array(0)
        let sampleRate = 22050
        let headerDone = false
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (disposed || token !== controller.__readAloudToken) {
            try {
              await reader.cancel()
            } catch (error) {
              /* already closed */
            }
            return
          }
          /* Concatenate whatever arrived into one buffer before framing. */
          const merged = new Uint8Array(pending.length + value.length)
          merged.set(pending, 0)
          merged.set(value, pending.length)
          pending = merged
          if (!headerDone) {
            if (pending.length < 12) continue
            if (String.fromCharCode(pending[0], pending[1], pending[2], pending[3]) !== 'DRS1') {
              throw new Error('流式数据格式不正确')
            }
            sampleRate = pending[4] | (pending[5] << 8) | (pending[6] << 16) | (pending[7] << 24)
            pending = pending.slice(12)
            headerDone = true
          }
          let offset = 0
          while (pending.length - offset >= 4) {
            const length = pending[offset] | (pending[offset + 1] << 8) | (pending[offset + 2] << 16) | (pending[offset + 3] << 24)
            if (pending.length - offset - 4 < length) break
            const samples = new Float32Array(length / 2)
            for (let at = 0; at < samples.length; at += 1) {
              const at2 = offset + 4 + at * 2
              const raw = pending[at2] | (pending[at2 + 1] << 8)
              samples[at] = (raw >= 0x8000 ? raw - 0x10000 : raw) / 32768
            }
            scheduleSamples(timeline, samples, sampleRate)
            offset += 4 + length
          }
          pending = pending.slice(offset)
        }
        /* Deliberately not waiting for playback: the caller moves on to the next
           chunk so its synthesis overlaps this one's audio. The whole reading is
           drained once at the end. */
      }

      /**
       * Play a list of engine-tagged chunks in order.
       *
       * Neural audio is streamed and scheduled on one shared timeline, so a
       * sentence starts playing while it is still being synthesized. Chunks from
       * a system voice or a cloud voice are played as whole files.
       *
       * A sentence that fails to synthesize must not silence the rest of the
       * reply: one unreadable URL or one transient synthesis error used to end
       * the whole reading at that point, so everything after it was never
       * spoken. Failures are now skipped, and only a run of them — which means
       * the engine itself is down — stops playback but reports the error.
       * @param {object[]} items - engine-tagged chunks.
       * @param {number} rate - speed multiplier.
       * @param {number} myToken - generation token guarding stale callbacks.
       * @param {object} systemOptions - resolved { voice, lang } for system chunks.
       */
      const playItems = (items, rate, myToken, systemOptions) => {
        const controller = new AbortController()
        controller.__readAloudToken = myToken
        fetchAbort = controller
        const timeline = { context: null, nextAt: 0, sources: new Set(), endAt: 0 }
        playbackTimeline = timeline
        let index = 0
        /* Skip a bad sentence, but give up when the engine is clearly broken. */
        let failures = 0
        let firstFailure = null

        const step = async () => {
          if (disposed || myToken !== token) return
          if (index >= items.length) {
            await waitForTimeline(timeline, controller)
            if (disposed || myToken !== token) return
            reset(firstFailure)
            return
          }
          const item = items[index]
          try {
            store.set({ chunkIndex: index })
            if (item.engine === 'neural') {
              if (ensureAudioContext(timeline) === null) {
                /* No Web Audio: fall back to a whole-file WAV request. */
                await waitForTimeline(timeline, controller)
                const blob = await synthesizeItem(item, rate, controller)
                if (disposed || myToken !== token) return
                await playBlob(blob)
              } else {
                await playPcmStream(item, rate, controller, timeline)
              }
            } else if (item.engine === 'cloud') {
              /* Whole-file audio cannot be appended to the PCM timeline. */
              await waitForTimeline(timeline, controller)
              const blob = await synthesizeItem(item, rate, controller)
              if (disposed || myToken !== token) return
              await playBlob(blob)
            } else {
              /* A system utterance must not talk over scheduled neural audio. */
              await waitForTimeline(timeline, controller)
              if (disposed || myToken !== token) return
              await speakSystemItem(item, systemOptions, rate)
            }
            if (disposed || myToken !== token) return
            failures = 0
            index += 1
            step()
          } catch (error) {
            if (disposed || myToken !== token) return
            const name = error && error.name ? String(error.name) : ''
            if (name === 'AbortError') return
            failures += 1
            if (firstFailure === null) firstFailure = String((error && error.message) || 'read-error')
            if (failures >= 3) {
              reset(firstFailure)
              return
            }
            index += 1
            step()
          }
        }
        step()
      }

      /**
       * Start reading, replacing whatever was playing.
       * @param {string} messageId - key identifying the speaking surface.
       * @param {string} text - raw reply text.
       * @param {object} prefs - stored preferences.
       * @param {object} voice - resolved voice: `{ kind: 'neural' | 'system', ... }`.
       * @returns {boolean} whether playback started.
       */
      const speak = (messageId, text, prefs, voice) => {
        if (disposed) return false
        const speechText = toSpeechText(text)
        if (speechText.length === 0) return false
        const neuralVoice = voice !== undefined
          && (voice.kind === 'neural' || voice.kind === 'cloud')
          && typeof voice.id === 'string'
          ? voice
          : null
        if (neuralVoice === null && synth === null) return false
        const rate = clampNumber(prefs && prefs.rate, 0.5, 2, 1)
        const items = buildSpeechItems(speechText, neuralVoice, synth !== null)
        if (items.length === 0) return false
        stop()
        token += 1
        const myToken = token
        const engines = new Set(items.map((item) => item.engine))
        store.set({
          messageId,
          playing: true,
          chunkIndex: 0,
          chunkCount: items.length,
          engine: engines.size > 1 ? 'mixed' : items[0].engine,
          error: null,
        })
        playItems(items, rate, myToken, resolveOptions(prefs, voice && voice.name))
        return true
      }

      const dispose = () => {
        if (disposed) return
        stop()
        disposed = true
      }

      return {
        supported: synth !== null,
        store,
        speak,
        stop,
        dispose,
      }
    }

    // ---------------------------------------------------------------------
    // Preferences
    // ---------------------------------------------------------------------

    /** Automatic reading modes: after each turn settles, or as the reply streams. */
    const READ_MODES = ['final', 'stream']

    /**
     * Read the stored preferences.
     * @returns {{ voice: string, rate: number, mode: 'final' | 'stream' }} preferences.
     */
    function loadPrefs() {
      const fallback = { voice: '', rate: 1, mode: 'final' }
      if (typeof window === 'undefined' || !window.localStorage) return fallback
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        return {
          voice: parsed && typeof parsed.voice === 'string' ? parsed.voice : '',
          rate: clampNumber(parsed && parsed.rate, 0.5, 2, 1),
          mode: parsed && READ_MODES.includes(parsed.mode) ? parsed.mode : 'final',
        }
      } catch (error) {
        return fallback
      }
    }

    /**
     * Persist the preferences; failures are ignored (private mode, quota).
     * @param {{ voice: string, rate: number, mode?: string }} prefs - preferences to store.
     */
    function savePrefs(prefs) {
      if (typeof window === 'undefined' || !window.localStorage) return
      try {
        window.localStorage.setItem(
          PREFS_KEY,
          JSON.stringify({ voice: prefs.voice, rate: prefs.rate, mode: prefs.mode || 'final' }),
        )
      } catch (error) {
        /* persistence is best-effort */
      }
    }

    /** Per-session automatic-reading switches, stored as `{ [sessionId]: true }`. */
    const AUTO_KEY = 'dsh-read-aloud:auto'

    /**
     * Read the per-session automatic-reading switches.
     * @returns {Record<string, boolean>} session id to enabled.
     */
    function loadAutoMap() {
      if (typeof window === 'undefined' || !window.localStorage) return {}
      try {
        const raw = window.localStorage.getItem(AUTO_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        const result = {}
        for (const [key, value] of Object.entries(parsed)) {
          if (value === true) result[key] = true
        }
        return result
      } catch (error) {
        return {}
      }
    }

    /**
     * Persist the per-session switches.
     * @param {Record<string, boolean>} map - session id to enabled.
     */
    function saveAutoMap(map) {
      if (typeof window === 'undefined' || !window.localStorage) return
      try {
        window.localStorage.setItem(AUTO_KEY, JSON.stringify(map))
      } catch (error) {
        /* persistence is best-effort */
      }
    }

    /** Turns already read, stored as `{ [sessionId]: [turnId, ...] }`. */
    const READ_KEY = 'dsh-read-aloud:read'

    /** How many Turn ids to keep per session; older ones are dropped. */
    const READ_HISTORY_LIMIT = 40

    /**
     * Read the turns that were already spoken, so a reload never reads them again.
     *
     * `readTurns` used to live only in memory: a reload cleared it while the
     * automatic-reading switch survived in localStorage, so the reply that was
     * still on screen got read aloud again on every restart.
     * @returns {Map<string, Set<string | number>>} session id to its read Turn ids.
     */
    function loadReadHistory() {
      const empty = new Map()
      if (typeof window === 'undefined' || !window.localStorage) return empty
      try {
        const raw = window.localStorage.getItem(READ_KEY)
        if (!raw) return empty
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
        const result = new Map()
        for (const [sessionId, ids] of Object.entries(parsed)) {
          if (!Array.isArray(ids)) continue
          result.set(sessionId, new Set(ids))
        }
        return result
      } catch (error) {
        return empty
      }
    }

    /**
     * Persist the read Turn ids per session.
     * @param {Map<string, Set<string | number>>} history - session id to its read Turn ids.
     */
    function saveReadHistory(history) {
      if (typeof window === 'undefined' || !window.localStorage) return
      try {
        const plain = {}
        for (const [sessionId, ids] of history) {
          if (ids.size === 0) continue
          plain[sessionId] = [...ids].slice(-READ_HISTORY_LIMIT)
        }
        window.localStorage.setItem(READ_KEY, JSON.stringify(plain))
      } catch (error) {
        /* persistence is best-effort */
      }
    }

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------

    /** Speaker with two sound waves, drawn in the host's action-row size. */
    function SpeakerIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block' },
        },
        h('path', { d: 'M4 9.5v5h3.1l4.4 3.5V6L7.1 9.5H4z' }),
        h('path', { d: 'M15.1 8.7a4.7 4.7 0 0 1 0 6.6' }),
        h('path', { d: 'M17.7 6a8.3 8.3 0 0 1 0 12' }),
      )
    }

    /**
     * Speaker with a play mark, distinguishing automatic reading from the
     * one-shot speaker action.
     * @param {{ enabled: boolean }} props - whether automatic reading is armed.
     * @returns {React.ReactElement} the icon.
     */
    function AutoIcon(props) {
      const enabled = props !== undefined && props.enabled === true
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block' },
        },
        h('path', { d: 'M4 9.5v5h3.1l4.4 3.5V6L7.1 9.5H4z' }),
        enabled ? h('path', { d: 'M15.1 8.7a4.7 4.7 0 0 1 0 6.6' }) : h('path', { d: 'M17.5 9.5v5' }),
        h('path', { d: enabled ? 'M17.7 6a8.3 8.3 0 0 1 0 12' : 'M20.5 7v10' }),
      )
    }

    /**
     * Voice list that survives the async `voiceschanged` load.
     * @returns {SpeechSynthesisVoice[]} ordered voices.
     */
    function useVoices() {
      const synth = React.useMemo(() => getSynthesizer(), [])
      const [voices, setVoices] = React.useState(() => voiceOptions())
      React.useEffect(() => {
        if (synth === null) return undefined
        const update = () => setVoices(voiceOptions())
        update()
        if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', update)
        const timer = window.setTimeout(update, 700)
        return () => {
          window.clearTimeout(timer)
          if (typeof synth.removeEventListener === 'function') synth.removeEventListener('voiceschanged', update)
        }
      }, [synth])
      return voices
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------

    /**
     * Register the dictionaries, the assistant-message speaker action, and the
     * General settings row.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'read-aloud: dictionaries')

      const player = createPlayer()
      ctx.effect(() => () => player.dispose(), 'read-aloud: player')

      const prefs = createStore(loadPrefs())
      const updatePrefs = (patch) => {
        const next = Object.assign({}, prefs.getSnapshot(), patch)
        prefs.set(next)
        savePrefs(prefs.getSnapshot())
      }

      /*
       * The Host's installed neural voices. The first read happens on startup;
       * a failed or slow read is not fatal, because reading still works with
       * the browser's system voice.
       */
      const catalog = createStore({ loaded: false, available: false, engine: 'system', reason: null, voices: [] })
      let catalogAt = 0
      let catalogPending = null
      const refreshCatalog = (force) => {
        if (!force && catalog.getSnapshot().loaded && Date.now() - catalogAt < VOICE_CACHE_MS) {
          return Promise.resolve(catalog.getSnapshot())
        }
        if (catalogPending !== null) return catalogPending
        catalogPending = loadHostVoices()
          .then((result) => {
            catalogAt = Date.now()
            catalog.set(Object.assign({ loaded: true }, result))
            return result
          })
          .finally(() => {
            catalogPending = null
          })
        return catalogPending
      }
      ctx.effect(() => {
        refreshCatalog(true)
        return () => undefined
      }, 'read-aloud: voice catalogue')

      /**
       * Read one item aloud with the resolved voice.
       * @param {string} surfaceId - message id or preview id.
       * @param {string} text - text to speak.
       * @returns {boolean} whether playback started.
       */
      const readItem = (surfaceId, text) => {
        const snapshot = catalog.getSnapshot()
        const voice = resolveVoice(prefs.getSnapshot().voice, flattenVoices(snapshot.voices))
        return player.speak(surfaceId, text, prefs.getSnapshot(), voice)
      }

      /*
       * Per-session automatic reading.
       *
       * `final` reads the whole reply once its turn closes. `stream` reads while
       * the reply is still arriving: it cuts the growing text at sentence
       * boundaries and remembers how much it already spoke, so nothing repeats
       * and no half sentence is read out. The mode is captured when a turn
       * starts, so switching it never truncates something already being read.
       */
      /*
       * `createStore` merges a patch, so this store holds the map under one key:
       * merging a plain map would keep deleted session ids alive as `false`.
       */
      const autoStore = createStore({ map: loadAutoMap() })
      /** Read the current per-session switches. */
      const autoEnabled = () => autoStore.getSnapshot().map

      /**
       * Stop automatic playback that belongs to one session.
       *
       * Turning the switch off must silence the session immediately: waiting for
       * the current sentence to finish would leave audio running for seconds
       * after the user asked it to stop.
       * @param {string} sessionId - session whose automatic audio should end.
       * @param {boolean} everything - also drop every other session's backlog.
       */
      const stopAuto = (sessionId, everything) => {
        const state = player.store.getSnapshot()
        /* A manual read is left alone: it was not started by this switch. */
        if (state.playing && isAutoId(state.messageId)) {
          if (everything === true || String(state.messageId).startsWith(sessionId + AUTO_SEP)) player.stop()
        }
        for (let index = autoQueue.length - 1; index >= 0; index -= 1) {
          if (everything === true || autoQueue[index].id.startsWith(sessionId + AUTO_SEP)) {
            autoQueue.splice(index, 1)
          }
        }
        /*
         * The "already read" memory is deliberately kept: forgetting it would
         * make switching the switch back on re-read the reply that was just
         * stopped.
         */
      }



      /** Turns already handled, so one turn is never read twice. */
      const readTurns = new Set()
      /**
       * Read Turn ids per session, restored from localStorage.
       *
       * Kept apart from `readTurns` (which uses `${sessionId}|${turnId}` keys)
       * so the on-disk shape stays small and readable.
       */
      const readHistory = loadReadHistory()
      for (const [sessionId, ids] of readHistory) {
        for (const id of ids) readTurns.add(sessionId + '|' + id)
      }
      /**
       * Sessions whose history has been marked read in this page's lifetime.
       *
       * The auto-read switch survives a reload through localStorage while
       * `readTurns` does not, so a session may be observed for the first time
       * after a restart with its switch already on.
       */
      const armedSessions = new Set()
      /** Streaming cursors: `${sessionId}|${turn}` -> `{ cursor, text }`. */
      const streamCursors = new Map()
      /** Mode captured when each turn was first seen, so switching never cuts one short. */
      const turnModes = new Map()
      /**
       * Auto-read backlog.
       *
       * Sentences are queued rather than spoken on arrival, because starting a
       * new utterance cancels the current one: streaming straight into
       * `player.speak` would truncate every sentence but the last.
       */
      const autoQueue = []
      /** Id separator marking a playback id as automatic. */
      const AUTO_SEP = '\u0001'

      /** Whether a playback id came from automatic reading. */
      const isAutoId = (id) => typeof id === 'string' && id.includes(AUTO_SEP)

      /**
       * Speak queued auto-read items one at a time.
       *
       * A queued item can be unreadable — `speak` returns false when the text
       * cleans down to nothing or no engine is available. Dropping it silently
       * used to leave the rest of the queue waiting for a playback that never
       * started, so keep taking items until one actually begins.
       */
      const drainAuto = () => {
        if (player.store.getSnapshot().playing) return
        /* Skip anything queued for a session that has since been switched off. */
        while (autoQueue.length > 0) {
          const next = autoQueue.shift()
          const owner = String(next.id).split(AUTO_SEP)[0]
          if (autoEnabled()[owner] !== true) continue
          const started = readItem(next.id, next.text)
          if (started) return
        }
      }

      /* Playback ends with no other signal, so pump the queue from the store. */
      ctx.effect(
        () =>
          player.store.subscribe(() => {
            if (!player.store.getSnapshot().playing) drainAuto()
          }),
        'read-aloud: auto queue pump',
      )

      /**
       * Enqueue text for automatic reading.
       * @param {string} id - playback id, marked as automatic.
       * @param {string} text - text to speak.
       */
      const enqueueAuto = (id, text) => {
        autoQueue.push({ id, text })
        drainAuto()
      }

      /**
       * Collect the snapshot's Turns in timeline order.
       *
       * `turnOrder` is the ascending order the chat package itself uses; the
       * `turns` map is only a fallback when that list is absent.
       * @param {object} snapshot - Chat snapshot.
       * @returns {Array<{ id: string | number, turn: object }>} ordered Turns.
       */
      const orderedTurns = (snapshot) => {
        const timeline = snapshot && snapshot.timeline
        if (timeline === null || timeline === undefined || typeof timeline.turns?.entries !== 'function') return []
        const result = []
        try {
          for (const [key, turn] of timeline.turns.entries()) {
            if (turn === null || typeof turn !== 'object') continue
            const id = typeof key === 'number' || typeof key === 'string'
              ? key
              : turn.start !== null && turn.start !== undefined && typeof turn.start.seq === 'number'
                ? turn.start.seq
                : undefined
            if (id === undefined) continue
            result.push({ id, turn })
          }
        } catch (error) {
          return []
        }
        return result
      }

      /**
       * Read one Turn's assistant text and settled state.
       *
       * A finished Turn carries `turn-tail.closing.blocks`; an in-flight one
       * exposes its newest step through `assistant-step`, whose `status` stays
       * `running` until the step settles. Text may legitimately be empty right
       * after a Turn starts, which is different from "this Turn has no reply".
       * @param {object} turn - one Turn from the snapshot.
       * @returns {{ text: string, closed: boolean } | null} content, or null when the Turn has no assistant data.
       */
      const turnContent = (turn) => {
        const readTurnData = (name) => {
          const data = turn.data
          return data !== undefined && data !== null && typeof data.get === 'function' ? data.get(name) : undefined
        }
        let blocks = null
        let closed = true
        const tail = readTurnData('turn-tail')
        const closing = tail && tail.closing
        if (closing !== null && closing !== undefined && Array.isArray(closing.blocks)) {
          blocks = closing.blocks
          closed = true
        } else if (Array.isArray(turn.steps) && turn.steps.length > 0) {
          const step = turn.steps[turn.steps.length - 1]
          const stepData = step && step.data
          const assistant = stepData !== null && stepData !== undefined && typeof stepData.get === 'function'
            ? stepData.get('assistant-step')
            : undefined
          if (assistant !== null && assistant !== undefined && Array.isArray(assistant.blocks)) {
            blocks = assistant.blocks
            closed = assistant.status !== 'running'
          }
        }
        if (blocks === null) return null
        const text = blocks
          .filter((block) => block && block.kind === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        return { text, closed }
      }

      /**
       * Read the newest Turn only.
       *
       * Never falling back to an older Turn matters: while a new reply is still
       * empty, falling back would read the previous answer first and the current
       * one afterwards, which is the opposite of what automatic reading means.
       * @param {object} snapshot - Chat snapshot.
       * @returns {{ text: string, closed: boolean, turn: string | number } | null} newest Turn, or null when there is none.
       */
      const turnReply = (snapshot) => {
        if (snapshot === null || typeof snapshot !== 'object') return null
        const all = orderedTurns(snapshot)
        if (all.length === 0) return null
        const newest = all[all.length - 1]
        const content = turnContent(newest.turn)
        /* A Turn with no assistant data yet is simply not ready to speak. */
        if (content === null) return { text: '', closed: false, turn: newest.id }
        return { text: content.text, closed: content.closed, turn: newest.id }
      }

      /**
       * Record that one Turn has been spoken, in memory and on disk.
       * @param {string} sessionId - owning session.
       * @param {string | number} turnId - the Turn's id.
       */
      const markRead = (sessionId, turnId) => {
        readTurns.add(sessionId + '|' + turnId)
        let ids = readHistory.get(sessionId)
        if (ids === undefined) {
          ids = new Set()
          readHistory.set(sessionId, ids)
        }
        ids.add(turnId)
        saveReadHistory(readHistory)
      }

      /**
       * Mark the Turns that were already finished when the switch was turned on.
       *
       * Without this, switching automatic reading on would immediately read the
       * reply that is already on screen. A Turn still being generated is left
       * unmarked so its reply is read as it arrives.
       * @param {string} sessionId - session being armed.
       * @param {object} snapshot - Chat snapshot at the moment of arming.
       */
      const armSession = (sessionId, snapshot) => {
        for (const entry of orderedTurns(snapshot)) {
          const content = turnContent(entry.turn)
          if (content === null) continue
          if (content.closed) markRead(sessionId, entry.id)
        }
      }

      /**
       * Mark a session's on-screen history as read, once the history has arrived.
       *
       * Arming cannot happen on the very first snapshot: a freshly opened page
       * reports an empty timeline before the session's Turns are loaded, and
       * arming against that empty snapshot would mark nothing as read while
       * still counting the session as armed — so the history that arrives a
       * moment later would be spoken. Wait until the snapshot actually carries
       * at least one Turn, which is exactly the point where history is known.
       * @param {string} sessionId - session being observed.
       * @param {object} snapshot - Chat snapshot.
       */
      const ensureArmed = (sessionId, snapshot) => {
        if (armedSessions.has(sessionId)) return
        if (orderedTurns(snapshot).length === 0) return
        armedSessions.add(sessionId)
        armSession(sessionId, snapshot)
      }

      /**
       * Turn automatic reading on or off for one session.
       * @param {string} sessionId - session to change.
       * @param {boolean} enabled - desired state.
       * @param {object} [snapshot] - Chat snapshot at the moment of the click, used to skip history.
       */
      const setAuto = (sessionId, enabled, snapshot) => {
        const next = Object.assign({}, autoStore.getSnapshot().map)
        if (enabled) next[sessionId] = true
        else delete next[sessionId]
        autoStore.set({ map: next })
        saveAutoMap(next)
        if (enabled) {
          /* Arming against an empty snapshot would mark nothing; retry when turns arrive. */
          if (orderedTurns(snapshot).length === 0) {
            armedSessions.delete(sessionId)
          } else {
            armedSessions.add(sessionId)
            armSession(sessionId, snapshot)
          }
        } else {
          armedSessions.delete(sessionId)
          stopAuto(sessionId, false)
        }
      }
      /**
       * Decide where reading resumes for the text currently on screen.
       *
       * `turnContent` reports only the newest Assistant step while a Turn is
       * still running, and that step replaces the previous one's text wholesale
       * whenever the model starts a new step. A cursor counted over the whole
       * Turn would then point past the start of the new step, silently skipping
       * everything before it — the rest of the step was read, its opening was
       * not. So the cursor only carries over while the text still begins with
       * what was already spoken; a replaced text starts again from zero.
       * @param {{ cursor: number, text: string } | undefined} prev - state of the last snapshot.
       * @param {string} text - text of the current snapshot.
       * @returns {number} characters already spoken from `text`.
       */
      const streamCursorFor = (prev, text) => {
        if (prev === undefined || prev === null) return 0
        const cursor = typeof prev.cursor === 'number' ? prev.cursor : 0
        if (cursor <= 0) return 0
        const seen = typeof prev.text === 'string' ? prev.text : ''
        /* Same source: the text merely grew, so the spoken prefix still holds. */
        return text.slice(0, cursor) === seen.slice(0, cursor) ? cursor : 0
      }

      /**
       * Split off the part of `text` that is safe to speak now.
       *
       * In stream mode only complete sentences past the cursor are returned, so
       * a half sentence is never read out; the rest waits for the next update.
       * @param {string} text - full text so far.
       * @param {number} cursor - characters already spoken.
       * @param {boolean} closed - whether the text is final.
       * @returns {{ speak: string, next: number }} text to speak and the new cursor.
       */
      const takeSpeakable = (text, cursor, closed) => {
        if (text.length <= cursor) return { speak: '', next: cursor }
        const fresh = text.slice(cursor)
        if (closed) return { speak: fresh, next: text.length }
        const at = Math.max(
          fresh.lastIndexOf('。'),
          fresh.lastIndexOf('！'),
          fresh.lastIndexOf('？'),
          fresh.lastIndexOf('!'),
          fresh.lastIndexOf('?'),
          fresh.lastIndexOf('\n'),
        )
        if (at < 0) return { speak: '', next: cursor }
        return { speak: fresh.slice(0, at + 1), next: cursor + at + 1 }
      }

      /**
       * Handle a Chat snapshot for automatic reading.
       * @param {string} sessionId - owning session.
       * @param {object} snapshot - Chat snapshot.
       */
      const handleAuto = (sessionId, snapshot) => {
        if (sessionId === undefined || autoEnabled()[sessionId] !== true) return
        /*
         * The switch's "on" state is persisted in localStorage, but readTurns is
         * in-memory, and armSession() runs only when the user clicks the switch.
         * After a reload the switch is therefore on with nothing marked as read,
         * and the reply already on screen would be read as if it just arrived.
         * `ensureArmed` restores the "history is not news" rule, and it waits for
         * the history to actually load before it counts the session as armed.
         */
        ensureArmed(sessionId, snapshot)
        const state = player.store.getSnapshot()
        /* A manual read of a specific reply is never interrupted. */
        if (state.playing && state.messageId !== null && state.messageId !== undefined && !isAutoId(state.messageId)) return
        const info = turnReply(snapshot)
        if (info === null) return
        const key = sessionId + '|' + info.turn
        /*
         * A finished Turn that was already marked read is history. The final
         * mode checks this itself, but the stream mode would otherwise speak it,
         * so the guard lives here where both modes pass through.
         */
        if (info.closed && readTurns.has(key)) return
        if (!turnModes.has(key)) turnModes.set(key, prefs.getSnapshot().mode || 'final')
        const mode = turnModes.get(key)
        if (mode === 'final') {
          if (!info.closed || readTurns.has(key)) return
          /*
           * Mark read only when there is something to say. A reply whose text
           * converts to nothing (a table used to become a space) was marked read
           * without ever being spoken, so it could never be read afterwards.
           */
          if (toSpeechText(info.text).length === 0) return
          markRead(sessionId, info.turn)
          enqueueAuto(sessionId + AUTO_SEP + info.turn, info.text)
          return
        }
        /* stream mode */
        const previous = streamCursors.get(key)
        const cursor = streamCursorFor(previous, info.text)
        /*
         * A step can end mid-sentence: `takeSpeakable` only speaks up to the last
         * sentence break, and the next snapshot may replace the whole text with a
         * different step's. The unspoken remainder would then never be completed
         * and would be lost, so speak it now, before the replacement is read.
         *
         * The remainder exists in two shapes, and both must be rescued:
         *  - text was spoken, then replaced: the cursor falls back to 0;
         *  - nothing was spoken because the step had no sentence break at all, so
         *    the cursor never left 0 — a step ending in a colon (a lead-in to a
         *    tool call) is exactly this case.
         * A step whose text merely grew still shares its prefix, so it is not a
         * replacement and nothing is spoken early.
         */
        if (previous !== undefined && previous !== null) {
          const replaced = previous.cursor > 0
            ? cursor === 0
            : previous.text.length > 0 && !info.text.startsWith(previous.text)
          if (replaced) {
            const rest = previous.text.slice(previous.cursor)
            if (toSpeechText(rest).length > 0) {
              enqueueAuto(sessionId + AUTO_SEP + info.turn + AUTO_SEP + 'tail' + AUTO_SEP + previous.cursor, rest)
            }
          }
        }
        const taken = takeSpeakable(info.text, cursor, info.closed)
        streamCursors.set(key, { cursor: taken.next, text: info.text })
        /*
         * A finished Turn is only "read" once some of it was actually queueable.
         * Marking it read while the remaining text converts to nothing would
         * lock the Turn out of every later snapshot.
         */
        const speakable = toSpeechText(taken.speak)
        if (info.closed && (speakable.length > 0 || cursor > 0)) markRead(sessionId, info.turn)
        if (speakable.length === 0) return
        enqueueAuto(sessionId + AUTO_SEP + info.turn + AUTO_SEP + cursor, taken.speak)
      }

      /*
       * Find-or-create the stylesheet and always (re)write it: a hot update of
       * this module must not keep an older generation's CSS.
       */
      ctx.effect(() => {
        const tagId = 'dsh-read-aloud'
        let tag = document.querySelector('style[data-plugin-css="' + tagId + '"]')
        if (tag === null) {
          tag = document.createElement('style')
          tag.dataset.plugin = '@local/dsh-read-aloud'
          tag.dataset.pluginCss = tagId
          document.head.appendChild(tag)
        }
        tag.textContent = CSS
        return () => {
          tag.remove()
        }
      }, 'read-aloud: styles')

      /**
       * One speaker action under a finalized assistant reply.
       * @param {object} props - slot owner props (messageId), standard hooks, localized `t`, injected player/prefs.
       * @returns {React.ReactElement | null} the action, or null for replies with no speakable text.
       */
      function ReadAloudAction(props) {
        const { messageId, t, useChat, player: playback, catalog: voiceCatalog } = props
        const state = useStore(playback.store)
        const catalogue = useStore(voiceCatalog)
        const text = useChat((snapshot) => replyTextOf(snapshot, messageId))
        const speechText = React.useMemo(() => toSpeechText(text), [text])
        /* Either engine alone is enough to offer the action. */
        const canRead = playback.supported || catalogue.available
        if (!canRead || speechText.length === 0) return null
        const speaking = state.playing && state.messageId === messageId
        const label = speaking ? t('action.stop') : t('action.read')
        return h(
          'button',
          {
            type: 'button',
            className: 'dra-action' + (speaking ? ' dra-action--active' : ''),
            'data-reading': speaking ? 'true' : undefined,
            'aria-label': label,
            'aria-pressed': speaking || undefined,
            title: label,
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              if (speaking) playback.stop()
              else readItem(messageId, speechText)
            },
          },
          speaking
            ? h(
                'span',
                { className: 'dra-eq', 'aria-hidden': true },
                [0, 1, 2].map((bar) => h('i', { key: bar, style: { animationDelay: bar * 150 + 'ms' } })),
              )
            : h(SpeakerIcon, {}),
        )
      }

      /**
       * The General settings row: voice, speed, preview.
       * @param {object} props - localized `t` and injected player/prefs.
       * @returns {React.ReactElement} the settings row.
       */
      function ReadAloudSettings(props) {
        const { t, player: playback, prefs: preferenceStore, catalog: voiceCatalog } = props
        const state = useStore(playback.store)
        const preference = useStore(preferenceStore)
        const catalogue = useStore(voiceCatalog)
        const voices = useVoices()
        const previewing = state.playing && state.messageId === PREVIEW_ID
        const neuralVoices = flattenVoices(catalogue.voices)
        const hasNeural = neuralVoices.length > 0
        /* Groups keep the trade-offs visible: local fast, local slow, remote.
           A cloud voice needs the network, a slow pack needs patience. */
        const neuralCloud = neuralVoices.filter((voice) => voice.engine === 'cloud')
        const neuralLocal = neuralVoices.filter((voice) => voice.engine !== 'cloud')
        const neuralFast = neuralLocal.filter((voice) => voice.slow !== true)
        const neuralSlow = neuralLocal.filter((voice) => voice.slow === true)
        const canRead = playback.supported || hasNeural
        /* The mode selector only matters when automatic reading is possible. */
        const canAuto = canRead
        /*
         * The stored value may name a voice that is no longer installed; show
         * what reading would actually use instead of a dangling selection.
         */
        const resolved = resolveVoice(preference.voice, neuralVoices)
        /* Both local and cloud entries are keyed `neural:` in the <select>; the
           key itself carries the `cloud:` marker for remote ones. */
        const selectedValue = resolved.kind === 'neural' || resolved.kind === 'cloud'
          ? NEURAL_PREFIX + resolved.key
          : resolved.name
            ? SYSTEM_PREFIX + resolved.name
            : ''
        const description = hasNeural
          ? t('settings.descriptionNeural', { count: neuralVoices.length })
          : playback.supported
            ? t('settings.description')
            : t('settings.unsupported')
        return h(
          'div',
          { className: 'dra-item' },
          h(
            'div',
            { className: 'dra-row' },
            h(
              'div',
              { className: 'dra-text' },
              h('div', { className: 'dra-title' }, t('settings.title')),
              h('div', { className: 'dra-description' }, description),
            ),
            canRead
              ? h(
                  'div',
                  { className: 'dra-controls' },
                  h(
                    'label',
                    { className: 'dra-field dra-field--voice' },
                    h('span', { className: 'dra-field-label' }, t('settings.voice')),
                    h(
                      'select',
                      {
                        className: 'dra-select',
                        value: selectedValue,
                        'aria-label': t('settings.voice'),
                        title: resolved.kind === 'neural' && resolved.label ? resolved.label : undefined,
                        onChange: (event) => {
                          updatePrefs({ voice: event.target.value })
                          refreshCatalog(true)
                        },
                      },
                      h('option', { value: '' }, t('settings.voiceDefault')),
                      neuralFast.length > 0
                        ? h(
                            'optgroup',
                            { label: t('settings.groupNeural') },
                            neuralFast.map((voice) =>
                              h(
                                'option',
                                { key: voice.key, value: NEURAL_PREFIX + voice.key },
                                voice.label + (voice.language ? ' · ' + voice.language : ''),
                              ),
                            ),
                          )
                        : null,
                      neuralSlow.length > 0
                        ? h(
                            'optgroup',
                            { label: t('settings.groupNeuralSlow') },
                            neuralSlow.map((voice) =>
                              h(
                                'option',
                                { key: voice.key, value: NEURAL_PREFIX + voice.key },
                                voice.label + (voice.language ? ' · ' + voice.language : ''),
                              ),
                            ),
                          )
                        : null,
                      neuralCloud.length > 0
                        ? h(
                            'optgroup',
                            { label: t('settings.groupCloud') },
                            neuralCloud.map((voice) =>
                              h(
                                'option',
                                { key: voice.key, value: NEURAL_PREFIX + voice.key },
                                voice.label + (voice.language ? ' · ' + voice.language : ''),
                              ),
                            ),
                          )
                        : null,
                      h(
                        'optgroup',
                        {
                          label: hasNeural ? t('settings.groupSystem') : t('settings.groupSystemOnly'),
                        },
                        voices.map((voice) =>
                          h(
                            'option',
                            {
                              key: (voice.voiceURI || voice.name) + '|' + voice.lang,
                              value: SYSTEM_PREFIX + voice.name,
                            },
                            shortVoiceName(voice) + ' · ' + langTag(voice),
                          ),
                        ),
                      ),
                    ),
                  ),
                  h(
                    'label',
                    { className: 'dra-field' },
                    h('span', { className: 'dra-field-label' }, t('settings.rate')),
                    h('input', {
                      className: 'dra-range',
                      type: 'range',
                      min: 0.5,
                      max: 2,
                      step: 0.05,
                      value: preference.rate,
                      'aria-label': t('settings.rate'),
                      onChange: (event) => updatePrefs({ rate: Number(event.target.value) }),
                    }),
                    h('span', { className: 'dra-rate' }, preference.rate.toFixed(2) + '\u00d7'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dra-button',
                      onClick: () => {
                        if (previewing) playback.stop()
                        else readItem(PREVIEW_ID, t('settings.previewText'))
                      },
                    },
                    previewing ? t('settings.previewStop') : t('settings.preview'),
                  ),
                )
              : null,
            /*
             * Automatic reading gets its own line instead of sharing the one
             * above: voice + speed + preview already fill 440px of the 564px
             * content column, and a fourth control would push it to wrap.
             */
            canAuto
              ? h(
                  'div',
                  { className: 'dra-controls dra-controls--auto' },
                  h(
                    'label',
                    { className: 'dra-field dra-field--mode' },
                    h('span', { className: 'dra-field-label' }, t('settings.mode')),
                    h(
                      'select',
                      {
                        className: 'dra-select dra-select--mode',
                        value: preference.mode || 'final',
                        'aria-label': t('settings.mode'),
                        title: t('settings.modeHint'),
                        onChange: (event) => updatePrefs({ mode: event.target.value }),
                      },
                      h('option', { value: 'final' }, t('settings.modeFinal')),
                      h('option', { value: 'stream' }, t('settings.modeStream')),
                    ),
                  ),
                )
              : null,
          ),
          state.error !== null && state.error !== undefined
            ? h('div', { className: 'dra-error', role: 'alert' }, t('settings.error', { message: state.error }))
            : null,
        )
      }

      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'read-aloud',
            order: 12,
            locale: NS,
            inject: () => ({ player, prefs, catalog }),
          },
          ReadAloudAction,
        ),
      )

      /**
       * Header toggle that arms automatic reading for the current session only.
       * @param {object} props - standard Session props plus injected auto store.
       * @returns {React.ReactElement | null} the toggle, or null when unavailable.
       */
      function AutoReadToggle(props) {
        const { t, sessionId, useChat, auto, player: playback } = props
        const map = useStore(auto).map
        const catalogue = useStore(catalog)
        /*
         * Stay optimistic until the catalogue has actually loaded: hiding the
         * switch while `/voices` is in flight would make it appear only after
         * some unrelated re-render.
         */
        const canRead = playback.supported || catalogue.available || catalogue.loaded !== true
        const enabled = sessionId !== undefined && map[sessionId] === true
        /*
         * The subscription is what drives automatic reading: every Chat snapshot
         * update re-runs this selector, and the effect reacts to new text.
         */
        const snapshot = useChat((value) => value)
        React.useEffect(() => {
          if (sessionId === undefined) return
          handleAuto(sessionId, snapshot)
        }, [sessionId, snapshot, enabled])
        if (sessionId === undefined || !canRead) return null
        const label = enabled ? t('auto.on') : t('auto.off')
        return h(
          'button',
          {
            type: 'button',
            className: 'dra-header' + (enabled ? ' dra-header--on' : ''),
            'data-auto-read': enabled ? 'true' : 'false',
            'aria-label': label,
            'aria-pressed': enabled || undefined,
            title: label,
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              setAuto(sessionId, !enabled, snapshot)
            },
          },
          h(AutoIcon, { enabled }),
        )
      }

      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'read-aloud-auto',
            order: 5,
            locale: NS,
            inject: () => ({ player, prefs, catalog, auto: autoStore }),
          },
          AutoReadToggle,
        ),
      )

      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'read-aloud',
            order: 40,
            locale: NS,
            inject: () => ({ player, prefs, catalog }),
          },
          ReadAloudSettings,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
