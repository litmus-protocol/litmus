import type { SVGProps } from "react";

// 2px-stroke line icons (UI kit). Decorative by default.

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function make(paths: React.ReactNode) {
  return function Icon({ size = 16, ...props }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

export const LogoIcon = make(
  <>
    <path d="M4 4h9l-2 6 4 2-3 8H4z" />
    <path d="M15 4h5v16h-4" />
  </>,
);
export const LockIcon = make(
  <>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </>,
);
export const SendIcon = make(<path d="M7 17 17 7M9 7h8v8" />);
export const BanIcon = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m5.7 5.7 12.6 12.6" />
  </>,
);
export const CheckIcon = make(<path d="M5 12l5 5L20 7" />);
export const XIcon = make(<path d="M18 6 6 18M6 6l12 12" />);
export const WarnIcon = make(<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />);
export const BackIcon = make(<path d="M19 12H5M11 18l-6-6 6-6" />);
export const NextIcon = make(<path d="M5 12h14M13 6l6 6-6 6" />);
export const ChevronIcon = make(<path d="m9 18 6-6-6-6" />);
export const ShieldIcon = make(
  <>
    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </>,
);
export const ChainIcon = make(
  <>
    <path d="M12 2 3 7v10l9 5 9-5V7z" />
    <path d="m9 12 2 2 4-4" />
  </>,
);
export const ClockIcon = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);
export const WalletIcon = make(
  <>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M3 10h18" />
  </>,
);
export const HistoryIcon = make(
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </>,
);
export const PlusIcon = make(<path d="M12 5v14M5 12h14" />);
export const TrashIcon = make(<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />);
export const CopyIcon = make(
  <>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </>,
);
export const BoltIcon = make(<path d="M13 2 3 14h9l-1 8 10-12h-9z" />);
export const ChatIcon = make(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);
export const SunIcon = make(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </>,
);
export const MoonIcon = make(<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />);
export const DownloadIcon = make(<path d="M12 3v12M7 10l5 5 5-5M5 21h14" />);
