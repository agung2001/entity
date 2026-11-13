/**
 * The entity mark — a voxel character, not a letterform.
 *
 * A 9 × 9 field of square cells standing on two shaded depth layers, so the
 * block reads solid from the front. It is built once from a face map and then
 * driven channel by channel — breathing on a sine, eyes tracking on a spring,
 * blinks in two hard pixel steps, and (only where the mark is the whole
 * statement) a squash-and-stretch hop. One requestAnimationFrame loop drives
 * every instance on screen.
 *
 * Mood and colour are user settings rather than motion: the same animation runs
 * under every mood, and the glyph pinned to the extruded corner is what
 * distinguishes them.
 */
import { reactive } from 'vue'

const U = 4
const N = 9
const O = -18

const EYES = [
  [2, 3],
  [5, 3],
]

/**
 * Twenty-five silhouettes, all on the same 9 × 9 pixel field so the face,
 * blink, gaze and breathing stay intact. They are hand-drawn masks rather than
 * vector paths: a missing pixel is as meaningful as a filled one, and an arch
 * or a sparkle can keep a hole without changing the animation pipeline.
 */
export const SHAPES = [
  {
    id: 'squircle',
    name: 'Squircle',
    /* The original nine-row face. The logo and every entity that never picked
       a silhouette keep exactly the shape and animation they had before the
       shape picker existed. */
    mask: [
      '011111110', '111111111', '111111111', '111111111', '111111111',
      '111111111', '111111111', '111111111', '011111110',
    ],
  },
  {
    id: 'blob',
    name: 'Blob',
    mask: [
      '001111000', '011111100', '111111110', '111111111', '111111111',
      '111111110', '111111100', '011111000', '001110000',
    ],
  },
  {
    id: 'pebble',
    name: 'Pebble',
    mask: [
      '000000000', '001111000', '011111100', '111111110', '111111111',
      '111111110', '011111100', '001111000', '000000000',
    ],
  },
  {
    id: 'bean',
    name: 'Bean',
    mask: [
      '001110000', '011111100', '111111110', '111111110', '111111110',
      '111111100', '111111000', '011110000', '001100000',
    ],
  },
  {
    id: 'egg',
    name: 'Egg',
    mask: [
      '000111000', '001111100', '011111110', '011111110', '111111110',
      '111111110', '111111100', '011111100', '001111000',
    ],
  },
  {
    id: 'tablet',
    name: 'Tablet',
    mask: [
      '000000000', '011111110', '011111110', '011111110', '011111110',
      '011111110', '011111110', '011111110', '000000000',
    ],
  },
  {
    id: 'capsule',
    name: 'Capsule',
    mask: [
      '000000000', '001111000', '011111110', '111111111', '111111111',
      '111111111', '011111110', '001111000', '000000000',
    ],
  },
  {
    id: 'cylinder',
    name: 'Cylinder',
    mask: [
      '000000000', '001111100', '011111110', '011111110', '011111110',
      '011111110', '011111110', '001111100', '000000000',
    ],
  },
  {
    id: 'hex',
    name: 'Hex',
    mask: [
      '000111000', '001111100', '011111110', '111111111', '111111111',
      '111111111', '011111110', '001111100', '000111000',
    ],
  },
  {
    id: 'gem',
    name: 'Gem',
    mask: [
      '000011000', '000111100', '001111110', '011111110', '011111110',
      '001111100', '000111000', '000010000', '000000000',
    ],
  },
  {
    id: 'crystal',
    name: 'Crystal',
    mask: [
      '000011000', '000111100', '001111110', '001111110', '011111110',
      '011111110', '001111110', '000111100', '000011000',
    ],
  },
  {
    id: 'wedge',
    name: 'Wedge',
    mask: [
      '000010000', '000111000', '001111100', '011111110', '011111110',
      '111111110', '111111110', '011111110', '001111100',
    ],
  },
  {
    id: 'shield',
    name: 'Shield',
    mask: [
      '000000000', '111111111', '111111111', '111111111', '111111111',
      '011111110', '011111110', '001111100', '000111000',
    ],
  },
  {
    id: 'dome',
    name: 'Dome',
    mask: [
      '000000000', '001111100', '011111110', '111111111', '111111111',
      '111111111', '111111111', '111111111', '000000000',
    ],
  },
  {
    id: 'arch',
    name: 'Arch',
    mask: [
      '000000000', '001111100', '011111110', '111111111', '111111111',
      '111001111', '111001111', '111001111', '111001111',
    ],
  },
  {
    id: 'cloud',
    name: 'Cloud',
    mask: [
      '000110000', '001111100', '011111110', '111111111', '111111111',
      '111111111', '111111111', '011111110', '001111000',
    ],
  },
  {
    id: 'teardrop',
    name: 'Drop',
    mask: [
      '000010000', '000111000', '001111100', '001111100', '011111110',
      '011111110', '011111110', '001111100', '000111000',
    ],
  },
  {
    id: 'leaf',
    name: 'Leaf',
    mask: [
      '000110000', '001111000', '001111100', '011111110', '011111110',
      '011111100', '001111000', '000110000', '000000000',
    ],
  },
  {
    id: 'square',
    name: 'Square',
    mask: [
      '000000000', '011111110', '011111110', '011111110', '011111110',
      '011111110', '011111110', '011111110', '000000000',
    ],
  },
  {
    id: 'sparkle',
    name: 'Sparkle',
    mask: [
      '000010000', '000111000', '001111100', '111111111', '111111111',
      '111111111', '001111100', '000111000', '000010000',
    ],
  },
  {
    id: 'clover',
    name: 'Clover',
    mask: [
      '001100110', '011111110', '111111111', '111111111', '011111110',
      '011111110', '111111111', '111111111', '001100110',
    ],
  },
  {
    id: 'flower',
    name: 'Flower',
    mask: [
      '000010000', '001111100', '011011110', '111111111', '111111111',
      '111111111', '011011110', '001111100', '000010000',
    ],
  },
  {
    id: 'heart',
    name: 'Heart',
    mask: [
      '000000000', '001111100', '011111110', '111111111', '111111111',
      '011111110', '001111100', '000111000', '000010000',
    ],
  },
  {
    id: 'house',
    name: 'House',
    mask: [
      '000010000', '000111000', '001111100', '011111110', '111111110',
      '111111110', '111111110', '111111110', '000000000',
    ],
  },
  {
    id: 'star',
    name: 'Star',
    mask: [
      '000010000', '000111000', '001111100', '111111111', '011111110',
      '001111100', '001111100', '011101110', '010000010',
    ],
  },
  {
    id: 'pentagon',
    name: 'Pentagon',
    mask: [
      '000010000', '000111000', '001111100', '011111110', '111111111',
      '111111111', '111111111', '011111110', '000000000',
    ],
  },
  {
    id: 'octagon',
    name: 'Octagon',
    mask: [
      '001111100', '011111110', '111111111', '111111111', '111111111',
      '111111111', '111111111', '011111110', '001111100',
    ],
  },
  {
    id: 'diamond',
    name: 'Diamond',
    mask: [
      '000010000', '000111000', '001111100', '011111110', '111111111',
      '011111110', '001111100', '000111000', '000010000',
    ],
  },
  {
    id: 'bowl',
    name: 'Bowl',
    mask: [
      '000000000', '111111111', '111111111', '111111111', '111111111',
      '011111110', '001111100', '000111000', '000000000',
    ],
  },
  {
    id: 'tag',
    name: 'Tag',
    mask: [
      '000000000', '111111100', '111111110', '111111111', '111111110',
      '111111100', '011111000', '001110000', '000100000',
    ],
  },
]

const DEFAULT_SHAPE = 'squircle'
export const shapeById = (id) => SHAPES.find((shape) => shape.id === id) || SHAPES[0]

/* One cadence for every mark. How far the gaze travels, how often it re-aims,
   how often the lids close, how greedy a wink is and how slow the breath is. */
const BASE = { gaze: 3.2, gazeEvery: [2100, 2800], blinkEvery: [2400, 3400], wink: 0.28, breathe: 520, lid: 0 }

export const MOODS = [
  { id: 'none', name: 'Default', glyph: '' },
  { id: 'happy', name: 'Happy', glyph: '😄' },
  { id: 'cool', name: 'Cool', glyph: '😎' },
  { id: 'focus', name: 'Focused', glyph: '🧠' },
  { id: 'sleepy', name: 'Sleepy', glyph: '😴' },
  { id: 'hype', name: 'Excited', glyph: '🤩' },
]

/**
 * The mood drawer. Quick moods are only the shortlist; this is the searchable
 * library behind it, grouped so the drawer can be browsed without typing.
 */
export const EMOJI_GROUPS = [
  {
    id: 'faces',
    label: 'Faces',
    items: [
      { glyph: '😀', name: 'Grinning', keywords: 'smile happy' },
      { glyph: '😄', name: 'Happy', keywords: 'smile joy grin' },
      { glyph: '😁', name: 'Beaming', keywords: 'grin smile' },
      { glyph: '😆', name: 'Laughing', keywords: 'lol grin' },
      { glyph: '😅', name: 'Relieved', keywords: 'sweat smile' },
      { glyph: '😂', name: 'Tears of joy', keywords: 'laugh cry' },
      { glyph: '🙂', name: 'Calm', keywords: 'smile' },
      { glyph: '🙃', name: 'Upside down', keywords: 'silly' },
      { glyph: '😉', name: 'Wink', keywords: 'flirt' },
      { glyph: '😊', name: 'Content', keywords: 'blush smile' },
      { glyph: '😇', name: 'Angel', keywords: 'innocent' },
      { glyph: '🥰', name: 'Loved', keywords: 'hearts smile' },
      { glyph: '😍', name: 'Heart eyes', keywords: 'love' },
      { glyph: '🤩', name: 'Starstruck', keywords: 'excited hype' },
      { glyph: '😎', name: 'Cool', keywords: 'shades' },
      { glyph: '🥳', name: 'Party', keywords: 'celebrate' },
      { glyph: '🤓', name: 'Nerd', keywords: 'glasses smart' },
      { glyph: '🧐', name: 'Curious', keywords: 'monocle think' },
      { glyph: '🤔', name: 'Thinking', keywords: 'hmm' },
      { glyph: '🤗', name: 'Hug', keywords: 'warm' },
      { glyph: '🤭', name: 'Giggle', keywords: 'oops' },
      { glyph: '🤫', name: 'Quiet', keywords: 'shh' },
      { glyph: '🫡', name: 'Salute', keywords: 'yes sir' },
      { glyph: '😏', name: 'Smirk', keywords: 'clever' },
      { glyph: '😌', name: 'Peaceful', keywords: 'calm' },
      { glyph: '😴', name: 'Sleepy', keywords: 'tired sleep' },
      { glyph: '😪', name: 'Drowsy', keywords: 'tired' },
      { glyph: '🤤', name: 'Drooling', keywords: 'hungry' },
      { glyph: '😮', name: 'Surprised', keywords: 'oh wow' },
      { glyph: '😲', name: 'Astonished', keywords: 'wow' },
      { glyph: '🥺', name: 'Pleading', keywords: 'please' },
      { glyph: '😢', name: 'Sad', keywords: 'cry' },
      { glyph: '😭', name: 'Sobbing', keywords: 'cry' },
      { glyph: '😤', name: 'Determined', keywords: 'huff' },
      { glyph: '😠', name: 'Angry', keywords: 'mad' },
      { glyph: '🤯', name: 'Mind blown', keywords: 'explode wow' },
      { glyph: '🥶', name: 'Freezing', keywords: 'cold' },
      { glyph: '😱', name: 'Scream', keywords: 'fear' },
      { glyph: '🤖', name: 'Robot', keywords: 'bot ai' },
      { glyph: '👽', name: 'Alien', keywords: 'space' },
    ],
  },
  {
    id: 'creatures',
    label: 'Creatures',
    items: [
      { glyph: '🐱', name: 'Cat', keywords: 'kitten pet' },
      { glyph: '🐶', name: 'Dog', keywords: 'puppy pet' },
      { glyph: '🦊', name: 'Fox', keywords: 'clever' },
      { glyph: '🐼', name: 'Panda', keywords: 'bear' },
      { glyph: '🐨', name: 'Koala', keywords: 'bear calm' },
      { glyph: '🐸', name: 'Frog', keywords: 'green' },
      { glyph: '🐙', name: 'Octopus', keywords: 'sea smart' },
      { glyph: '🦉', name: 'Owl', keywords: 'night wise' },
      { glyph: '🦄', name: 'Unicorn', keywords: 'magic' },
      { glyph: '🐝', name: 'Bee', keywords: 'busy honey' },
      { glyph: '🦋', name: 'Butterfly', keywords: 'transform' },
      { glyph: '🐢', name: 'Turtle', keywords: 'slow' },
      { glyph: '🐳', name: 'Whale', keywords: 'sea big' },
      { glyph: '🦕', name: 'Dinosaur', keywords: 'long neck' },
      { glyph: '🐲', name: 'Dragon', keywords: 'myth' },
      { glyph: '🦖', name: 'T-Rex', keywords: 'dinosaur' },
      { glyph: '🐧', name: 'Penguin', keywords: 'cold' },
      { glyph: '🦅', name: 'Eagle', keywords: 'bird focus' },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    items: [
      { glyph: '🧠', name: 'Brain', keywords: 'focus smart think' },
      { glyph: '💡', name: 'Idea', keywords: 'light bulb' },
      { glyph: '⚙️', name: 'Gear', keywords: 'settings build' },
      { glyph: '🛠️', name: 'Tools', keywords: 'fix build' },
      { glyph: '🚀', name: 'Rocket', keywords: 'ship launch fast' },
      { glyph: '🧪', name: 'Lab', keywords: 'test experiment' },
      { glyph: '📦', name: 'Package', keywords: 'box ship' },
      { glyph: '🔧', name: 'Wrench', keywords: 'fix' },
      { glyph: '🧭', name: 'Compass', keywords: 'navigate' },
      { glyph: '🔭', name: 'Telescope', keywords: 'explore' },
      { glyph: '💻', name: 'Laptop', keywords: 'code work' },
      { glyph: '⌨️', name: 'Keyboard', keywords: 'type code' },
      { glyph: '🧰', name: 'Toolbox', keywords: 'fix build' },
      { glyph: '📚', name: 'Books', keywords: 'read learn' },
      { glyph: '✏️', name: 'Pencil', keywords: 'write edit' },
      { glyph: '📝', name: 'Notes', keywords: 'write' },
      { glyph: '🗂️', name: 'Files', keywords: 'organize' },
      { glyph: '🔬', name: 'Microscope', keywords: 'inspect detail' },
    ],
  },
  {
    id: 'nature',
    label: 'Nature',
    items: [
      { glyph: '🌵', name: 'Cactus', keywords: 'desert' },
      { glyph: '🌲', name: 'Tree', keywords: 'forest' },
      { glyph: '🌳', name: 'Oak', keywords: 'forest' },
      { glyph: '🍀', name: 'Clover', keywords: 'luck' },
      { glyph: '🌸', name: 'Blossom', keywords: 'flower spring' },
      { glyph: '🌻', name: 'Sunflower', keywords: 'flower sun' },
      { glyph: '🌈', name: 'Rainbow', keywords: 'color' },
      { glyph: '☀️', name: 'Sun', keywords: 'day light' },
      { glyph: '🌙', name: 'Moon', keywords: 'night sleep' },
      { glyph: '⭐', name: 'Star', keywords: 'favorite' },
      { glyph: '✨', name: 'Sparkles', keywords: 'magic new' },
      { glyph: '🔥', name: 'Fire', keywords: 'hot burn' },
      { glyph: '🌊', name: 'Wave', keywords: 'sea water' },
      { glyph: '⚡', name: 'Bolt', keywords: 'fast power' },
      { glyph: '❄️', name: 'Snowflake', keywords: 'cold' },
      { glyph: '🍂', name: 'Leaves', keywords: 'autumn' },
      { glyph: '🌍', name: 'Earth', keywords: 'world' },
    ],
  },
  {
    id: 'food',
    label: 'Food',
    items: [
      { glyph: '☕', name: 'Coffee', keywords: 'drink fuel' },
      { glyph: '🍵', name: 'Tea', keywords: 'drink calm' },
      { glyph: '🍕', name: 'Pizza', keywords: 'food' },
      { glyph: '🍩', name: 'Donut', keywords: 'sweet' },
      { glyph: '🍪', name: 'Cookie', keywords: 'sweet' },
      { glyph: '🍎', name: 'Apple', keywords: 'fruit' },
      { glyph: '🥑', name: 'Avocado', keywords: 'fruit' },
      { glyph: '🍋', name: 'Lemon', keywords: 'sour' },
      { glyph: '🍉', name: 'Watermelon', keywords: 'fruit' },
      { glyph: '🍇', name: 'Grapes', keywords: 'fruit' },
      { glyph: '🍓', name: 'Strawberry', keywords: 'fruit' },
      { glyph: '🥨', name: 'Pretzel', keywords: 'snack' },
      { glyph: '🍿', name: 'Popcorn', keywords: 'movie snack' },
      { glyph: '🧁', name: 'Cupcake', keywords: 'sweet' },
    ],
  },
  {
    id: 'symbols',
    label: 'Symbols',
    items: [
      { glyph: '💎', name: 'Gem', keywords: 'diamond value' },
      { glyph: '🎯', name: 'Target', keywords: 'goal focus' },
      { glyph: '✅', name: 'Done', keywords: 'check ok' },
      { glyph: '❗', name: 'Alert', keywords: 'important' },
      { glyph: '❓', name: 'Question', keywords: 'help' },
      { glyph: '♻️', name: 'Recycle', keywords: 'loop reuse' },
      { glyph: '🔒', name: 'Locked', keywords: 'secure' },
      { glyph: '🔑', name: 'Key', keywords: 'access' },
      { glyph: '🔔', name: 'Bell', keywords: 'notify' },
      { glyph: '🎵', name: 'Music', keywords: 'note' },
      { glyph: '🎨', name: 'Palette', keywords: 'design art' },
      { glyph: '🏆', name: 'Trophy', keywords: 'win' },
      { glyph: '🧩', name: 'Puzzle', keywords: 'piece solve' },
      { glyph: '🪄', name: 'Wand', keywords: 'magic' },
      { glyph: '💫', name: 'Dizzy', keywords: 'stars' },
      { glyph: '🫧', name: 'Bubbles', keywords: 'clean' },
    ],
  },
]

const EMOJI_BY_GLYPH = new Map(
  EMOJI_GROUPS.flatMap((group) => group.items.map((item) => [item.glyph, item])),
)

export const COLORS = [
  { id: 'sun', name: 'Sun', v: 'var(--accent)', h: 78, hex: '#f8b956' },
  { id: 'ember', name: 'Ember', v: 'oklch(72% 0.16 42)', h: 42, hex: '#ec8b55' },
  { id: 'lime', name: 'Lime', v: 'oklch(85% 0.17 128)', h: 128, hex: '#cfe36f' },
  { id: 'mint', name: 'Mint', v: 'oklch(84% 0.13 175)', h: 175, hex: '#8adfc6' },
  { id: 'sky', name: 'Sky', v: 'oklch(80% 0.13 240)', h: 240, hex: '#8db6ed' },
  { id: 'orchid', name: 'Orchid', v: 'oklch(78% 0.15 310)', h: 310, hex: '#d59aeb' },
]

const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n))
const hex2 = (n) => Math.round(clamp(n) * 255).toString(16).padStart(2, '0')

/** HSL → #rrggbb. The wheel uses this; CSS custom properties accept either. */
export function hslToHex(h, s, l) {
  const hue = ((Number(h) % 360) + 360) % 360
  const sat = clamp(Number(s))
  const light = clamp(Number(l))
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = light - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) [r, g, b] = [c, x, 0]
  else if (hue < 120) [r, g, b] = [x, c, 0]
  else if (hue < 180) [r, g, b] = [0, c, x]
  else if (hue < 240) [r, g, b] = [0, x, c]
  else if (hue < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return `#${hex2(r + m)}${hex2(g + m)}${hex2(b + m)}`
}

/** The reverse, used only to place the wheel marker on an existing colour. */
export function hexToHsl(hex) {
  const value = String(hex || '').replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(value)) return { h: 78, s: 0.72, l: 0.62 }
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const l = (max + min) / 2
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0
  return { h, s, l }
}

const STORE_KEY = 'entity.mark'

export const markSettings = reactive({ mood: 'none', color: 'sun', shape: DEFAULT_SHAPE, custom: '' })

try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
  if (saved?.mood) markSettings.mood = saved.mood
  if (saved?.color) markSettings.color = saved.color
  if (saved?.shape) markSettings.shape = shapeById(saved.shape).id
  if (/^#[0-9a-f]{6}$/i.test(String(saved?.custom || ''))) markSettings.custom = saved.custom
} catch {
  /* a bad stored value just means the defaults */
}

export function moodById(id) {
  if (!id || id === 'none') return MOODS[0]
  const mood = MOODS.find((m) => m.id === id)
  if (mood) return mood
  const emoji = EMOJI_BY_GLYPH.get(id)
  return { id, name: emoji?.name || 'Custom', glyph: id }
}
export const moodGlyph = (id) => moodById(id).glyph
export const colorById = (id, custom = '') => {
  if (id === 'custom' && /^#[0-9a-f]{6}$/i.test(String(custom || ''))) {
    return { id: 'custom', name: 'Custom', v: custom, h: hexToHsl(custom).h, hex: custom }
  }
  return COLORS.find((c) => c.id === id) || COLORS[0]
}

function applyColor() {
  const c = colorById(markSettings.color, markSettings.custom)
  const root = document.documentElement
  root.style.setProperty('--mk', c.v)
  root.style.setProperty('--mk-h', String(c.h))
}
applyColor()

/* ── per-entity marks ─────────────────────────────────────────────
   A mood belongs to the entity it was picked for, not to the hub. Marks are
   cached by `workspace::entity` so every instance of the same entity (table,
   run journal, chat header) shares one reactive record, while a different
   entity reads its own record — and its own localStorage key. */
const ENTITY_MARK_PREFIX = 'entity.mark:'
const entityMarks = new Map()

const entityKey = (workspace, entity) => `${workspace || '_'}::${entity}`
const entityStoreKey = (workspace, entity) =>
  `${ENTITY_MARK_PREFIX}${workspace || '_'}:${entity}`

/** The mark record for one entity, or the hub's own mark when there is none.
 *  `fallback` lets a seeded entity carry its first shape/colour/mood in its own
 *  frontmatter; once the picker writes a localStorage record, that wins. */
export function markFor(workspace, entity, fallback = null) {
  if (!entity) return markSettings
  const key = entityKey(workspace, entity)
  let mark = entityMarks.get(key)
  if (!mark) {
    let saved = null
    try {
      saved = JSON.parse(localStorage.getItem(entityStoreKey(workspace, entity)) || 'null')
    } catch {
      /* a bad stored value just means the defaults */
    }
    mark = reactive({
      mood: saved?.mood || fallback?.mood || 'none',
      color: saved?.color || fallback?.color || 'sun',
      shape: shapeById(saved?.shape || fallback?.shape).id,
      custom: /^#[0-9a-f]{6}$/i.test(String(saved?.custom || '')) ? saved.custom : '',
    })
    entityMarks.set(key, mark)
  }
  return mark
}

/** Forget a deleted entity's mark so a later file with the same name starts clean. */
export function forgetMark(workspace, entity) {
  if (!entity) return
  entityMarks.delete(entityKey(workspace, entity))
  try {
    localStorage.removeItem(entityStoreKey(workspace, entity))
  } catch {
    /* private mode — nothing stored */
  }
}

/** Colour and badge are element-local, so two entities never share a colour. */
function applyMark(el, mark) {
  const c = colorById(mark.color, mark.custom)
  el.style.setProperty('--mk', c.v)
  el.style.setProperty('--mk-h', String(c.h))
  const badge = el.querySelector('.mood')
  if (badge) badge.textContent = moodGlyph(mark.mood)
}

const on = (mask, r, c) =>
  r >= 0 && r < N && c >= 0 && c < N && mask[r].charAt(c) === '1'

/* Light falls from the top-left: the top row and left column are the lit
   faces, the bottom row and right column fall into the extrusion shadow. */
function cell(mask, r, c) {
  const up = !on(mask, r - 1, c)
  const left = !on(mask, r, c - 1)
  const down = !on(mask, r + 1, c)
  const right = !on(mask, r, c + 1)
  if (up) return 'hi'
  if (left && !down) return 'hi'
  if (down || right || left) return 'sh'
  return 'fc'
}

/* Merge cells into runs so the surface has no seams and the DOM stays small. */
function runs(mask, d, fixed) {
  let s = ''
  for (let r = 0; r < N; r++) {
    let c = 0
    while (c < N) {
      if (!on(mask, r, c)) {
        c++
        continue
      }
      const k = fixed || cell(mask, r, c)
      let e = c
      while (e + 1 < N && on(mask, r, e + 1) && (fixed || cell(mask, r, e + 1) === k)) e++
      const x = O + c * U + d
      const y = O + r * U + d
      const w = (e - c + 1) * U
      s += `<rect class="${k}" x="${x}" y="${y}" width="${w}" height="${U}"/>`
      c = e + 1
    }
  }
  return s
}

function eyesFor(row) {
  return EYES.map((p, i) => {
    const x = O + p[0] * U
    const w = U * 2
    return (
      '<g class="ey">' +
      `<rect class="eye" x="${x}" y="${O + row * U}" width="${w}" height="${w}"/>` +
      `<rect class="glint" x="${x}" y="${O + row * U}" width="${U}" height="${U}"/>` +
      `<rect class="lid${i ? ' b' : ''}" x="${x}" y="${O + row * U}" width="${w}" height="${w}"/>` +
      '</g>'
    )
  }).join('')
}

const svgCache = new Map()
function svgFor(shapeId) {
  const shape = shapeById(shapeId)
  if (svgCache.has(shape.id)) return svgCache.get(shape.id)
  const mask = shape.mask
  const svg =
    '<svg viewBox="-21 -21 50 50" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
    '<g class="hd"><g class="bd">' +
    runs(mask, U * 2, 'dx2') +
    runs(mask, U, 'dx1') +
    runs(mask, 0) +
    eyesFor(3) +
    '</g></g></svg>'
  svgCache.set(shape.id, svg)
  return svg
}

/* Parsing one SVG string per mark was the expensive part of mounting a list
   of avatars. The markup depends only on the silhouette, so each shape is
   parsed once into a template and cloned from there. */
const shapeTemplates = new Map()

function shapeTemplate(shapeId) {
  let template = shapeTemplates.get(shapeId)
  if (!template) {
    template = document.createElement('template')
    template.innerHTML = svgFor(shapeId)
    shapeTemplates.set(shapeId, template)
  }
  return template
}

const reduced =
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const marks = []
/* `mini` marks are too small to read a blink or a gaze, and a history list can
   mount hundreds of them. They are painted once and left out of the frame loop;
   only the marks where motion is legible animate. */
const statics = []
let seq = 0
let seed = 20241111
let raf = 0
let frame = 0

const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

/** Paint every live mark from its own record — one write per mark, no re-render. */
export function syncMarkBadges() {
  for (const p of marks) applyMark(p.el, p.mark)
  for (const p of statics) applyMark(p.el, p.mark)
}

/**
 * Set the mark for one entity. Omitting `entity` edits the hub's brand mark.
 * Other entities are untouched: their mood and colour live in their own record.
 */
export function setMark({
  mood,
  color,
  shape,
  custom,
  workspace = '',
  entity = '',
  persist = true,
} = {}) {
  const target = entity ? markFor(workspace, entity) : markSettings
  if (mood !== undefined) target.mood = mood
  if (color) target.color = color
  if (shape !== undefined) target.shape = shapeById(shape).id
  if (custom !== undefined) target.custom = custom

  if (entity) {
    if (persist) {
      try {
        localStorage.setItem(
          entityStoreKey(workspace, entity),
          JSON.stringify({
            mood: target.mood,
            color: target.color,
            shape: target.shape,
            custom: target.custom,
          }),
        )
      } catch {
        /* private mode — the setting still holds for this session */
      }
    }
  } else {
    applyColor()
    if (persist) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(markSettings))
      } catch {
        /* private mode — the setting still holds for this session */
      }
    }
  }
  syncMarkBadges()
}

function hopCurve(u) {
  const K = [
    [0.0, 0.0, 1.0, 1.0],
    [0.12, 0.0, 0.9, 1.08],
    [0.34, -0.34, 1.05, 0.97],
    [0.54, -0.36, 1.02, 0.99],
    [0.68, 0.0, 0.9, 1.07],
    [0.82, -0.05, 1.04, 0.96],
    [1.0, 0.0, 1.0, 1.0],
  ]
  for (let j = 1; j < K.length; j++) {
    if (u <= K[j][0]) {
      const a = K[j - 1]
      const b = K[j]
      let f = (u - a[0]) / (b[0] - a[0])
      f = f * f * (3 - 2 * f)
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]
    }
  }
  return [0, 1, 1]
}

/* ── reactions ────────────────────────────────────────────────────
   The reference's seventeen reaction states, reduced to the channels this
   pixel character already has: lift, squash, roll, gaze, head tilt and lids.
   No silhouette morphing — the shape stays the same before, during and after. */
const TAU = Math.PI * 2
const clamp01 = (u) => Math.min(1, Math.max(0, u))
const pulseAt = (u) => Math.sin(Math.PI * clamp01(u))
const bounceAt = (u, n = 1) => Math.abs(Math.sin(Math.PI * clamp01(u) * n))
const easeAt = (u) => {
  const x = clamp01(u)
  return x * x * (3 - 2 * x)
}

export const REACTIONS = [
  {
    id: 'happy',
    label: 'Happy',
    duration: 1.15,
    frame: (u) => {
      const b = bounceAt(u, 2) * (1 - u * 0.18)
      return {
        lift: -8 * b,
        sx: 1 - 0.035 * b,
        sy: 1 + 0.055 * b,
        tilt: 2.4 * Math.sin(TAU * 2 * u),
        lida: 0.55,
        lidb: 0.55,
        ey: -0.7,
      }
    },
  },
  {
    id: 'excited',
    label: 'Excited',
    duration: 1.35,
    frame: (u) => {
      const b = bounceAt(u, 3) * (1 - u * 0.12)
      return {
        lift: -15 * b,
        sx: 1 - 0.06 * b,
        sy: 1 + 0.09 * b,
        roll: 3 * Math.sin(TAU * 4 * u),
        tilt: 4 * Math.sin(TAU * 3 * u),
        ex: 1.5 * Math.sin(TAU * 2 * u),
        ey: -1,
      }
    },
  },
  {
    id: 'laughing',
    label: 'Laughing',
    duration: 1.3,
    frame: (u) => {
      const b = bounceAt(u, 4) * (1 - u * 0.1)
      return {
        lift: -5 * b,
        sx: 1 + 0.018 * b,
        sy: 1 - 0.018 * b,
        mx: 2.2 * Math.sin(TAU * 6 * u),
        tilt: 6 * Math.sin(TAU * 5 * u),
        lida: 0.86,
        lidb: 0.86,
        ey: -0.4,
      }
    },
  },
  {
    id: 'proud',
    label: 'Proud',
    duration: 1.45,
    frame: (u) => {
      const p = pulseAt(u)
      return {
        lift: -1.5 * p,
        sx: 1 + 0.045 * p,
        sy: 1 + 0.06 * p,
        tilt: -3 * p,
        ey: -1.4,
        lida: 0.12,
        lidb: 0.12,
      }
    },
  },
  {
    id: 'curious',
    label: 'Curious',
    duration: 1.3,
    frame: (u) => {
      const p = pulseAt(u)
      return {
        tilt: 10 * p,
        roll: 2 * p,
        ex: 3.5 * p,
        ey: -1.8 * p,
        lida: 0.12,
        lidb: 0.46,
        sy: 1 + 0.02 * p,
      }
    },
  },
  {
    id: 'playful',
    label: 'Playful',
    duration: 1.35,
    frame: (u) => ({
      lift: -6 * bounceAt(u, 3),
      mx: 3 * Math.sin(TAU * 3 * u),
      roll: 8 * Math.sin(TAU * 2 * u),
      tilt: 4 * Math.sin(TAU * 3 * u),
      lida: 0.35,
      lidb: 0.15,
    }),
  },
  {
    id: 'shy',
    label: 'Shy',
    duration: 1.4,
    frame: (u) => {
      const p = pulseAt(u)
      return {
        sx: 0.94 + 0.02 * p,
        sy: 0.9 + 0.03 * p,
        tilt: -8 * p,
        mx: -2 * p,
        ex: -2.6 * p,
        ey: 1.8 * p,
        lida: 0.45,
        lidb: 0.45,
      }
    },
  },
  {
    id: 'surprised',
    label: 'Surprised',
    duration: 1.05,
    frame: (u) => {
      const p = pulseAt(u)
      const jump = Math.sin(Math.PI * clamp01(u * 1.6))
      return {
        lift: -19 * jump,
        sx: 1 - 0.07 * p,
        sy: 1 + 0.1 * p,
        tilt: -2 * p,
        ey: -1.2,
        ex: 0,
        lida: 0,
        lidb: 0,
      }
    },
  },
  {
    id: 'suspicious',
    label: 'Suspicious',
    duration: 1.5,
    frame: (u) => {
      const p = pulseAt(u)
      return {
        tilt: 7 * p,
        ex: 3 * p,
        ey: 0.4,
        lida: 0.7,
        lidb: 0.18,
        sx: 1 + 0.01 * p,
      }
    },
  },
  {
    id: 'angry',
    label: 'Angry',
    duration: 1.15,
    frame: (u) => {
      const shake = Math.sin(TAU * 10 * u) * (1 - u * 0.2)
      return {
        mx: 3.2 * shake,
        lift: -2 * bounceAt(u, 5),
        sx: 1.035,
        sy: 1.015,
        tilt: -2,
        ey: 1,
        lida: 0.66,
        lidb: 0.66,
      }
    },
  },
  {
    id: 'confused',
    label: 'Confused',
    duration: 1.55,
    frame: (u) => {
      const sway = Math.sin(TAU * 1.5 * u)
      return {
        tilt: 8 * sway,
        ex: 2.2 * sway,
        ey: -1,
        lida: 0.7,
        lidb: 0.18,
      }
    },
  },
  {
    id: 'sad',
    label: 'Sad',
    duration: 1.6,
    frame: (u) => {
      const p = pulseAt(u)
      return {
        lift: 3 * p,
        sx: 0.96,
        sy: 0.93,
        tilt: -4 * p,
        ey: 2.1 * p,
        lida: 0.55,
        lidb: 0.55,
      }
    },
  },
  {
    id: 'drowsy',
    label: 'Drowsy',
    duration: 1.9,
    frame: (u) => ({
      lift: 2 * pulseAt(u),
      sy: 0.96,
      tilt: 3 * Math.sin(Math.PI * u),
      ey: 1.6,
      lida: 0.8,
      lidb: 0.8,
    }),
  },
  {
    id: 'bored',
    label: 'Bored',
    duration: 1.7,
    frame: (u) => {
      const p = pulseAt(u)
      return {
        ex: 3.2 * p,
        ey: 1.1 * p,
        tilt: 2.4 * p,
        sy: 0.975,
        lida: 0.62,
        lidb: 0.62,
      }
    },
  },
  {
    id: 'scared',
    label: 'Scared',
    duration: 1.25,
    frame: (u) => {
      const shake = Math.sin(TAU * 12 * u) * (1 - u * 0.15)
      return {
        mx: 2.8 * shake,
        lift: -6 * bounceAt(u, 4),
        roll: 2 * shake,
        sx: 0.94,
        sy: 0.9,
        ey: -1,
        lida: 0,
        lidb: 0,
      }
    },
  },
  {
    id: 'celebrate',
    label: 'Celebrate',
    duration: 1.8,
    frame: (u) => {
      const b = Math.sin(Math.PI * clamp01(u))
      return {
        lift: -22 * b,
        roll: 360 * easeAt(u),
        sx: 1 - 0.05 * b,
        sy: 1 + 0.08 * b,
        lida: 0.35,
        lidb: 0.35,
      }
    },
  },
  {
    id: 'approving',
    label: 'Approving',
    duration: 1.2,
    frame: (u) => {
      const nod = Math.sin(Math.PI * clamp01(u * 1.4))
      return {
        lift: 3.5 * nod,
        tilt: -2 * nod,
        ey: -0.6 * nod,
        lida: 0,
        lidb: 1,
      }
    },
  },
]

const REACTION_BY_ID = new Map(REACTIONS.map((entry) => [entry.id, entry]))

function reactionDefaults() {
  return { lift: 0, sx: 1, sy: 1, mx: 0, roll: 0, tilt: 0, ex: 0, ey: 0, lida: 0, lidb: 0 }
}

function reactionFrameFor(p) {
  if (!p.reaction) return null
  const raw = p.reaction.frame(Math.min(1, p.reactionT / p.reaction.duration))
  const amp = p.mini ? 0.5 : 1
  return {
    ...reactionDefaults(),
    ...raw,
    lift: (raw.lift || 0) * amp,
    mx: (raw.mx || 0) * amp,
    roll: (raw.roll || 0) * amp,
    tilt: (raw.tilt || 0) * amp,
    sx: 1 + ((raw.sx ?? 1) - 1) * amp,
    sy: 1 + ((raw.sy ?? 1) - 1) * amp,
    lida: Math.min(1, Math.max(0, raw.lida ?? 0)),
    lidb: Math.min(1, Math.max(0, raw.lidb ?? 0)),
  }
}

function startReaction(p, id = 'random') {
  let entry = id === 'random' ? null : REACTION_BY_ID.get(id)
  if (!entry) {
    const pool = REACTIONS.filter((item) => item.id !== p.lastReaction)
    entry = pool[Math.floor(rnd() * pool.length)]
  }
  if (!entry) return false
  p.reaction = entry
  p.reactionT = 0
  p.lastReaction = entry.id
  return true
}

/** Trigger one of the seventeen reactions on every mark for an entity. */
export function playReaction(workspace, entity, id = 'random') {
  if (!entity) return false
  let played = false
  for (const p of marks) {
    if (p.entity !== entity) continue
    if (workspace && p.workspace !== workspace) continue
    if (startReaction(p, id)) played = true
  }
  return played
}

function tick(now) {
  /* A hidden window has no frames to show; keep the loop alive but write
     nothing until it is visible again. */
  if (document.hidden) {
    raf = requestAnimationFrame(tick)
    return
  }

  /* Mini marks are 20–28px tall. Half the frame rate is invisible at that size
     and halves the style writes on a list of them. Reactions still run at full
     speed, because those are the ones a person is meant to notice. */
  frame += 1
  const half = frame % 2 === 0

  for (let q = marks.length - 1; q >= 0; q--) {
    if (marks[q].el.isConnected === false) {
      marks.splice(q, 1)
      continue
    }
    const p = marks[q]
    if (p.mini && !p.reaction && !half) continue
    const el = p.el
    const dtms = p.prev ? Math.min(48, now - p.prev) : 16.7
    p.prev = now
    const t = now + p.phase
    const dt = dtms / 16.667
    const k = 0.11 * dt
    const dmp = Math.pow(0.85, dt)
    const pn = BASE
    const base = pn.lid

    /* Reactions are random punctuation for the large entity marks; forced
       reactions (chat events, the picker) may also play on a mini mark. */
    let rx = null
    if (p.reactions) {
      if (!p.reaction && !p.mini && t > p.nextReaction) startReaction(p)
      if (p.reaction) {
        p.reactionT += dtms / 1000
        if (p.reactionT >= p.reaction.duration) {
          p.reaction = null
          p.nextReaction = t + 3000 + rnd() * 4200
          el.dataset.reaction = ''
        } else {
          rx = reactionFrameFor(p)
          el.dataset.reaction = p.reaction.id
        }
      }
    }

    /* where to look next — the xs tier holds the gaze dead centre */
    if (t > p.lookAt) {
      p.lookAt = t + pn.gazeEvery[0] + rnd() * pn.gazeEvery[1]
      if (p.mini) {
        p.tx = 0
        p.ty = 0
        p.tt = 0
      } else {
        p.tx = (rnd() * 2 - 1) * pn.gaze
        p.ty = (rnd() * 2 - 1) * (pn.gaze * 0.47)
        p.tt = p.tx * 0.55
      }
    }
    p.ex.v = (p.ex.v + (p.tx - p.ex.x) * k) * dmp
    p.ex.x += p.ex.v
    p.ey.v = (p.ey.v + (p.ty - p.ey.x) * k) * dmp
    p.ey.x += p.ey.v
    p.tilt.v = (p.tilt.v + (p.tt - p.tilt.x) * k) * dmp
    p.tilt.x += p.tilt.v

    /* A reaction owns the eyelids; otherwise idle blinks continue. */
    if (rx) {
      p.lida = rx.lida
      p.lidb = rx.lidb
    } else {
      /* blink: 0.26s, closes in two hard steps, sometimes one eye only */
      if (p.blinkNow < 0 && t > p.blinkAt) {
        p.blinkNow = 0
        p.wink = rnd() < pn.wink
        p.blinkAt = t + pn.blinkEvery[0] + rnd() * pn.blinkEvery[1]
      }
      if (p.blinkNow >= 0) {
        p.blinkNow += dtms / 1000
        const bu = p.blinkNow / 0.26
        if (bu >= 1) {
          p.blinkNow = -1
          p.lida = base
          p.lidb = base
        } else {
          let bv = bu < 0.44 ? bu / 0.44 : bu < 0.56 ? 1 : 1 - (bu - 0.56) / 0.44
          bv = Math.min(1, Math.round(bv * 2) / 2)
          /* a resting lid sits under the blink, so the eye never opens wider
             than the preset allows */
          p.lidb = Math.max(base, bv)
          p.lida = p.wink ? base : Math.max(base, bv)
        }
      } else {
        p.lida = base
        p.lidb = base
      }
    }

    /* hop — only where the mark is the whole statement */
    if (p.hop) {
      if (p.hopNow < 0 && t > p.hopAt) {
        p.hopNow = 0
        p.hopAt = t + 3800 + rnd() * 3000
      }
      if (p.hopNow >= 0) {
        p.hopNow += dtms / 1000
        const hu = p.hopNow
        if (hu >= 1) {
          p.hopNow = -1
          p.lift = 0
          p.syf = 1
          p.sxf = 1
        } else {
          const hc = hopCurve(hu)
          p.lift = hc[0]
          p.syf = hc[1]
          p.sxf = hc[2]
        }
      }
    }

    const br = Math.sin(t / pn.breathe)
    const ex = rx ? rx.ex : p.ex.x
    const ey = rx ? rx.ey : p.ey.x
    const tilt = rx ? rx.tilt : p.tilt.x
    const sy = rx ? 1 : 1 + 0.022 * br
    const sx = rx ? 1 : 1 - 0.015 * br

    el.style.setProperty('--ex', ex.toFixed(2) + 'px')
    el.style.setProperty('--ey', ey.toFixed(2) + 'px')
    el.style.setProperty('--tilt', tilt.toFixed(2) + 'deg')
    el.style.setProperty('--lida', rx ? rx.lida : p.lida)
    el.style.setProperty('--lidb', rx ? rx.lidb : p.lidb)
    el.style.setProperty('--sy', sy.toFixed(4))
    el.style.setProperty('--sx', sx.toFixed(4))
    if (p.hop) {
      el.style.setProperty('--lift', (p.lift * 100).toFixed(2) + '%')
      el.style.setProperty('--syf', p.syf.toFixed(3))
      el.style.setProperty('--sxf', p.sxf.toFixed(3))
    }
    if (p.reactions) {
      const rv = rx || reactionDefaults()
      el.style.setProperty('--lift', rv.lift.toFixed(2) + '%')
      el.style.setProperty('--mx', rv.mx.toFixed(2) + 'px')
      el.style.setProperty('--roll', rv.roll.toFixed(2) + 'deg')
      el.style.setProperty('--sxf', rv.sx.toFixed(3))
      el.style.setProperty('--syf', rv.sy.toFixed(3))
    }
  }

  /* nothing on screen: stop the loop and let the next mount restart it */
  if (!marks.length) {
    raf = 0
    return
  }
  raf = requestAnimationFrame(tick)
}

function start() {
  if (raf || reduced) return
  raf = requestAnimationFrame(tick)
}

/**
 * Mount a mark into an element. Safe to call twice on the same element.
 * `badge` is off for the brand mark: the logo is a character, not an emoji.
 */
export function hydrateMark(
  el,
  {
    mini = false,
    hop = false,
    animate = false,
    mark = markSettings,
    shape = '',
    badge = true,
    reactions = false,
    entity = '',
    workspace = '',
  } = {},
) {
  if (!el || el.dataset.ready === '1') return
  el.dataset.ready = '1'
  el.replaceChildren(shapeTemplate(shape || mark.shape || DEFAULT_SHAPE).content.cloneNode(true))
  if (badge) {
    const pin = document.createElement('span')
    pin.className = 'mood'
    pin.setAttribute('aria-hidden', 'true')
    el.appendChild(pin)
  }
  applyMark(el, mark)

  if (mini && !hop && !animate) {
    statics.push({ el, mark })
    return
  }

  const idx = seq++
  marks.push({
    el,
    mini,
    hop,
    mark,
    reactions,
    entity,
    workspace,
    reaction: null,
    reactionT: 0,
    lastReaction: '',
    nextReaction: 2200 + rnd() * 2800,
    phase: idx * 431,
    prev: 0,
    ex: { x: 0, v: 0 },
    tx: 0,
    ey: { x: 0, v: 0 },
    ty: 0,
    tilt: { x: 0, v: 0 },
    tt: 0,
    lookAt: 700 + rnd() * 1900,
    blinkAt: 700 + rnd() * 2600,
    blinkNow: -1,
    wink: false,
    lida: 0,
    lidb: 0,
    hopAt: 2200 + rnd() * 3200,
    hopNow: -1,
    lift: 0,
    syf: 1,
    sxf: 1,
  })
  start()
}

export function releaseMark(el) {
  const i = marks.findIndex((p) => p.el === el)
  if (i > -1) marks.splice(i, 1)
  const j = statics.findIndex((p) => p.el === el)
  if (j > -1) statics.splice(j, 1)
}
