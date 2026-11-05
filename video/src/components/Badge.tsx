import React from 'react';
import { THEME } from '../theme';

interface BadgeProps {
  label: string;
  variant?: 'cyan' | 'coral' | 'amber' | 'green' | 'violet' | 'dim';
  size?: 'sm' | 'md';
}

export const Badge: React.FC<BadgeProps> = ({ label, variant = 'cyan', size = 'md' }) => {
  const colorMap = {
    cyan: {
      bg: 'rgba(105, 199, 219, 0.12)',
      border: 'rgba(105, 199, 219, 0.35)',
      text: THEME.colors.accentBright,
    },
    coral: {
      bg: 'rgba(224, 122, 106, 0.14)',
      border: 'rgba(224, 122, 106, 0.40)',
      text: THEME.colors.accentRed,
    },
    amber: {
      bg: 'rgba(217, 168, 78, 0.14)',
      border: 'rgba(217, 168, 78, 0.40)',
      text: THEME.colors.accentAmber,
    },
    green: {
      bg: 'rgba(79, 209, 155, 0.14)',
      border: 'rgba(79, 209, 155, 0.40)',
      text: THEME.colors.accentGreen,
    },
    violet: {
      bg: 'rgba(169, 150, 247, 0.14)',
      border: 'rgba(169, 150, 247, 0.40)',
      text: THEME.colors.accentViolet,
    },
    dim: {
      bg: 'rgba(108, 128, 150, 0.12)',
      border: 'rgba(108, 128, 150, 0.25)',
      text: THEME.colors.textMuted,
    },
  };

  const c = colorMap[variant];
  const isSm = size === 'sm';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: isSm ? '4px 10px' : '6px 14px',
        backgroundColor: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 6,
        color: c.text,
        fontFamily: THEME.fonts.mono,
        fontSize: isSm ? 16 : 20,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
    >
      {label}
    </span>
  );
};
