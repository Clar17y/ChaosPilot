import React from 'react';
import { THEME } from '../theme';

interface CardProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
  variant?: 'surface' | 'raised' | 'glass';
  borderColor?: string;
}

export const Card: React.FC<CardProps> = ({
  children,
  style,
  variant = 'surface',
  borderColor,
}) => {
  const bg =
    variant === 'glass'
      ? THEME.colors.bgSurfaceGlass
      : variant === 'raised'
      ? THEME.colors.bgRaised
      : THEME.colors.bgSurface;

  return (
    <div
      style={{
        backgroundColor: bg,
        border: `1px solid ${borderColor || THEME.colors.borderColor}`,
        borderRadius: 12,
        padding: '24px 28px',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.45)',
        ...style,
      }}
    >
      {children}
    </div>
  );
};
