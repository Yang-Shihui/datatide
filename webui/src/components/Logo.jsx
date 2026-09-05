// datatide 品牌标识：双层潮汐波 + 渐变圆角底
export function LogoMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="datatide">
      <defs>
        <linearGradient id="dt-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1e40af" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#dt-g)" />
      <path
        d="M6.5 20.5c3.2-4.2 5.8-4.2 9 0s5.8 4.2 9 0"
        fill="none" stroke="#fff" strokeWidth="2.7" strokeLinecap="round"
      />
      <path
        d="M6.5 13.5c3.2-4.2 5.8-4.2 9 0s5.8 4.2 9 0"
        fill="none" stroke="#fff" strokeWidth="2.7" strokeLinecap="round" opacity="0.45"
      />
    </svg>
  );
}
