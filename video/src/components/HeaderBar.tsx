import React from 'react';
import { THEME } from '../theme';
import { Badge } from './Badge';

interface HeaderBarProps {
  sceneTitle?: string;
  chapterNumber?: number;
  totalChapters?: number;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({
  sceneTitle = 'INVESTIGATION WORKBENCH',
  chapterNumber,
  totalChapters = 14,
}) => {
  return (
    <div
      style={{
        position: 'absolute',
        top: THEME.safeArea.top,
        left: THEME.safeArea.left,
        right: THEME.safeArea.right,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 50,
      }}
    >
      {/* Brand logo & title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {/* Glowing hexagonal ChaosPilot node icon */}
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            backgroundColor: 'rgba(105, 199, 219, 0.15)',
            border: `1.5px solid ${THEME.colors.accentBright}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 16px rgba(105, 199, 219, 0.3)',
          }}
        >
          <div
            style={{
              width: 12,
              height: 12,
              backgroundColor: THEME.colors.accentBright,
              transform: 'rotate(45deg)',
            }}
          />
        </div>

        <span
          style={{
            fontFamily: THEME.fonts.sans,
            fontSize: 26,
            fontWeight: 750,
            letterSpacing: '-0.02em',
            color: THEME.colors.textMain,
          }}
        >
          ChaosPilot
        </span>

        <span
          style={{
            fontFamily: THEME.fonts.mono,
            fontSize: 16,
            color: THEME.colors.textDim,
            letterSpacing: '0.06em',
            marginLeft: 4,
          }}
        >
          // WORKBENCH
        </span>
      </div>

      {/* Chapter & Telemetry Badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {chapterNumber && (
          <Badge
            label={`PHASE ${String(chapterNumber).padStart(2, '0')} / ${totalChapters}`}
            variant="dim"
            size="sm"
          />
        )}
        <Badge label={sceneTitle} variant="cyan" size="sm" />
      </div>
    </div>
  );
};
