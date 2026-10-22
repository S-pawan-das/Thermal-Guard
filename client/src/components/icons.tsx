import type { ReactNode } from "react";

// One small stroke-icon set (24 x 24, rounded ends) so the whole platform looks like one product.
const P: Record<string, ReactNode> = {
  home: <path d="M3.5 11.2 12 4l8.5 7.2V19a1.5 1.5 0 0 1-1.5 1.5h-4v-5.5h-6v5.5H5A1.5 1.5 0 0 1 3.5 19z" />,
  flame: <path d="M12 3c.8 3.2 5.2 5.2 5.2 9.8a5.2 5.2 0 0 1-10.4 0c0-2 .9-3.3 2-4.4.3 1.3.9 1.9 1.9 2.4C10.3 8.3 10.4 5.4 12 3z" />,
  layout: (<><rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" /><rect x="13" y="3.5" width="7.5" height="4.5" rx="2" /><rect x="13" y="10" width="7.5" height="10.5" rx="2" /><rect x="3.5" y="13" width="7.5" height="7.5" rx="2" /></>),
  sliders: (<><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>),
  bell: (<><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z" /><path d="M10 21a2 2 0 0 0 4 0" /></>),
  search: (<><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>),
  back: <path d="m15 5-7 7 7 7" />,
  next: <path d="m9 5 7 7-7 7" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  snowflake: (<><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9" /><path d="m9.5 4.5 2.5 2 2.5-2M9.5 19.5l2.5-2 2.5 2" /></>),
  factory: <path d="M3.5 20.5V9.5l6 3.5V9.5l6 3.5V5.5h3a1 1 0 0 1 1 1v14z" />,
  thermo: <path d="M10 14.6V5a2 2 0 1 1 4 0v9.6a4 4 0 1 1-4 0z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (<><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4.5M12 17.2v.3" /></>),
  stop: (<><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>),
  sparkle: <path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />,
  cube: (<><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" /></>),
  map: (<><path d="M3.5 6.5 9 4l6 2.5L20.5 4v13.5L15 20l-6-2.5L3.5 20z" /><path d="M9 4v13.5M15 6.5V20" /></>),
  power: <path d="M12 3.5v8M6.6 6.8a7.5 7.5 0 1 0 10.8 0" />,
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="m7 4.5 12 7.5-12 7.5z" />,
  reset: <path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5" />,
  trash: <path d="M5 7h14M9.5 7V4.5h5V7M7 7l.8 12.5h8.4L17 7" />,
  volume: <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5zM15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />,
  pulse: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  wand: <path d="m5 19 9-9M13 5l1 2.5L16.5 8.5 14 9.5 13 12l-1-2.5L9.5 8.5 12 7.5zM18 14l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  mute: <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5zM16 9.5l5 5m0-5-5 5" />,
};

export type IconName = keyof typeof P;

export default function Icon({ name, size = 22, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {P[name]}
    </svg>
  );
}
