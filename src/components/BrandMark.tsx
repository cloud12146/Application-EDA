import React from 'react';

export const BrandMark: React.FC<{ size?: number; className?: string }> = ({
  size = 36,
  className = '',
}) => (
  <div
    style={{ width: size, height: size }}
    className={`rounded-xl overflow-hidden bg-white shrink-0 ring-1 ring-slate-200/80 shadow-sm flex items-center justify-center p-0.5 ${className}`}
  >
    <img
      src="/glacetor-emblem.png"
      alt="Glacetor Remedies"
      width={size}
      height={size}
      className="w-full h-full object-contain block"
    />
  </div>
);

interface BrandLoaderProps {
  size?: number;
  label?: string;
  showFullLogo?: boolean;
  inline?: boolean;
  className?: string;
}

export const BrandLoader: React.FC<BrandLoaderProps> = ({
  size = 76,
  label = 'Loading Glacetor Remedies ERP...',
  showFullLogo = false,
  inline = false,
  className = '',
}) => {
  if (inline) {
    return (
      <span
        className={`relative inline-flex items-center justify-center shrink-0 ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <span className="absolute inset-0 rounded-full border-2 border-cyan-400/30 border-t-cyan-400 border-r-[#38BDF8] animate-glacetor-orbit" />
        <img
          src="/glacetor-emblem.png"
          alt=""
          className="w-[74%] h-[74%] rounded-full object-contain bg-white p-[1px] animate-glacetor-breathe"
        />
      </span>
    );
  }

  return (
    <div
      className={`flex flex-col items-center justify-center gap-4 text-center ${className}`}
      role="status"
      aria-live="polite"
    >
      <div
        className="relative flex items-center justify-center"
        style={{ width: size + 24, height: size + 24 }}
      >
        {/* Outer rotating orbital ring */}
        <div
          className="absolute inset-0 rounded-full border-[3px] border-slate-200 border-t-[#38BDF8] border-r-[#0F2744] animate-glacetor-orbit"
          aria-hidden="true"
        />
        {/* Secondary counter-subtle halo */}
        <div
          className="absolute inset-1.5 rounded-full border border-cyan-500/20"
          aria-hidden="true"
        />
        {/* Animated Glacetor Emblem on White Background */}
        <div
          className="rounded-full overflow-hidden bg-white shadow-md ring-1 ring-slate-200 flex items-center justify-center animate-glacetor-breathe"
          style={{ width: size, height: size }}
        >
          <img
            src="/glacetor-emblem.png"
            alt="Glacetor Remedies"
            width={size}
            height={size}
            className="w-full h-full object-contain p-1.5"
          />
        </div>
      </div>

      {showFullLogo && (
        <div className="bg-white rounded-xl px-4 py-2 border border-slate-200 shadow-sm">
          <img
            src="/glacetor-logo-white.png"
            alt="Glacetor Remedies Pvt. Ltd."
            className="h-9 sm:h-11 w-auto object-contain mx-auto"
          />
        </div>
      )}

      {label && (
        <div className="text-sm font-medium text-slate-600 tracking-tight">
          {label}
        </div>
      )}
    </div>
  );
};
