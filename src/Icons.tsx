import type { ReactNode } from 'react'

const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

export const Logo = () => (
  <svg viewBox="0 0 40 40" width="36" height="36" aria-hidden="true">
    <defs>
      <linearGradient id="logo" x1="0.1" y1="0" x2="0.9" y2="1">
        <stop offset="0" stopColor="#4fe3c1" />
        <stop offset="0.55" stopColor="#7c8cff" />
        <stop offset="1" stopColor="#b77bff" />
      </linearGradient>
    </defs>
    <path fill="url(#logo)" d="M20 3c5 0 7 7 11 12s7 10 3 15-13 7-19 6S3 31 4 25s6-8 9-13 3-9 7-9Z" />
  </svg>
)

export const Target = () => (
  <Svg>
    <circle cx="12" cy="12" r="6.5" />
    <circle cx="12" cy="12" r="1.8" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
  </Svg>
)
export const Minus = () => (
  <Svg>
    <path d="M6 12h12" />
  </Svg>
)
export const ZoomIn = () => (
  <Svg>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5M11 8.5v5M8.5 11h5" />
  </Svg>
)
export const Expand = () => (
  <Svg>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    <rect x="9" y="9" width="6" height="6" rx="1" />
  </Svg>
)
export const Bell = () => (
  <Svg>
    <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15l1.5-2Z" />
    <path d="M10 21.5a2.2 2.2 0 0 0 4 0" />
  </Svg>
)
export const BellOff = () => (
  <Svg>
    <path d="M8 5.8A6 6 0 0 1 18 11v4.5M6 9.5v7l-1.5 2H17M10 21.5a2.2 2.2 0 0 0 4 0M3.5 3.5l17 17" />
  </Svg>
)
export const History = () => (
  <Svg>
    <path d="M4 12a8 8 0 1 0 2.6-5.9L4 8.5" />
    <path d="M4 4v4.5h4.5M12 8v4.3l3 1.7" />
  </Svg>
)
export const Eye = () => (
  <Svg>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
)
export const EyeOff = () => (
  <Svg>
    <path d="M9.9 5.8A9.5 9.5 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.3 7.2C3.9 8.8 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.5-1.2M10 10a2.8 2.8 0 0 0 4 4M3.5 3.5l17 17" />
  </Svg>
)
export const Close = () => (
  <Svg>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
)
export const Check = () => (
  <Svg>
    <path d="m6 12.5 4 4 8-9" />
  </Svg>
)
export const Layers = () => (
  <Svg>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 12.5 9 5 9-5M3 16.5l9 5 9-5" />
  </Svg>
)
export const Branch = () => (
  <Svg>
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <path d="M8 16 16 8" />
  </Svg>
)
export const Clock = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5.2l3.2 2" />
  </Svg>
)
export const Chip = () => (
  <Svg>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3" />
  </Svg>
)
export const Gauge = () => (
  <Svg>
    <path d="M4 18a9 9 0 1 1 16 0" />
    <path d="m12 14 4-5" />
  </Svg>
)
export const Dollar = () => (
  <Svg>
    <path d="M12 3v18M16.5 7.5C16 6 14.5 5.5 12 5.5c-2.8 0-4.5 1.2-4.5 3.2 0 4.6 9.5 2.2 9.5 6.8 0 2-2 3-5 3-2.7 0-4.4-.8-5-2.5" />
  </Svg>
)
export const Wrench = () => (
  <Svg>
    <path d="M14.5 6.5a4 4 0 0 1 5-1.5l-2.7 2.7 1.5 1.5L21 6a4 4 0 0 1-5.5 5L8 18.5a2.1 2.1 0 0 1-3-3L12.5 8a4 4 0 0 1 2-1.5Z" />
  </Svg>
)
export const Chat = () => (
  <Svg>
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.2A2.5 2.5 0 0 1 4 13.5v-7Z" />
  </Svg>
)
