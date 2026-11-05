import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME, TOTAL_FRAMES } from '../theme';

interface BottomBarProps {
  absoluteFrame: number;
  provenanceText?: string;
}

export const BottomBar: React.FC<BottomBarProps> = ({
  absoluteFrame,
  provenanceText = 'ILLUSTRATIVE SCHEMATIC // RECORDED EVIDENCE INDEPENDENT OF LIVE LATENCY',
}) => {
  const { fps } = useVideoConfig();

  const progressPercent = Math.min(100, Math.max(0, (absoluteFrame / (TOTAL_FRAMES - 1)) * 100));
  const currentSeconds = Math.floor(absoluteFrame / fps);
  const minutes = Math.floor(currentSeconds / 60);
  const seconds = currentSeconds % 60;
  const timeFormatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} / 03:00`;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 40,
        left: THEME.safeArea.left,
        right: THEME.safeArea.right,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        zIndex: 50,
      }}
    >
      {/* Telemetry info row */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontFamily: THEME.fonts.mono,
          fontSize: 18,
          color: THEME.colors.textDim,
          letterSpacing: '0.04em',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: THEME.colors.accentCyan,
              boxShadow: `0 0 8px ${THEME.colors.accentCyan}`,
            }}
          />
          <span>{provenanceText}</span>
        </div>

        <div>
          <span>TIMECODE: </span>
          <span style={{ color: THEME.colors.textMain, fontWeight: 600 }}>{timeFormatted}</span>
        </div>
      </div>

      {/* Seekable progress bar */}
      <div
        style={{
          width: '100%',
          height: 3,
          backgroundColor: 'rgba(130, 170, 200, 0.16)',
          borderRadius: 2,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: `${progressPercent}%`,
            backgroundColor: THEME.colors.accentCyan,
            boxShadow: `0 0 10px ${THEME.colors.accentCyan}`,
          }}
        />
      </div>
    </div>
  );
};
