import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { THEME } from '../theme';

export const TelemetryBackground: React.FC = () => {
  const frame = useCurrentFrame();

  // Gentle subtle pulse in background glow
  const glowOpacity = interpolate(
    Math.sin(frame * 0.02),
    [-1, 1],
    [0.08, 0.16]
  );

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 1920,
        height: 1080,
        backgroundColor: THEME.colors.bgPrimary,
        overflow: 'hidden',
        zIndex: 0,
      }}
    >
      {/* Background radial telemetry glow */}
      <div
        style={{
          position: 'absolute',
          top: '-10%',
          right: '15%',
          width: 1000,
          height: 600,
          borderRadius: '50%',
          background: `radial-gradient(ellipse, rgba(105, 199, 219, ${glowOpacity}) 0%, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: '-10%',
          left: '10%',
          width: 800,
          height: 500,
          borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(224, 122, 106, 0.05) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      {/* High-tech telemetry grid lines (subtle hairline) */}
      <svg
        width="1920"
        height="1080"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          pointerEvents: 'none',
          opacity: 0.35,
        }}
      >
        <defs>
          <pattern id="gridPattern" width="120" height="120" patternUnits="userSpaceOnUse">
            <path
              d="M 120 0 L 0 0 0 120"
              fill="none"
              stroke="rgba(130, 170, 200, 0.12)"
              strokeWidth="1"
            />
            {/* Fine crosshairs at intersection */}
            <circle cx="0" cy="0" r="1.5" fill="rgba(105, 199, 219, 0.35)" />
          </pattern>
        </defs>
        <rect width="1920" height="1080" fill="url(#gridPattern)" />

        {/* Telemetry frame border markers */}
        <line x1="80" y1="50" x2="1840" y2="50" stroke="rgba(130, 170, 200, 0.16)" strokeWidth="1" />
        <line x1="80" y1="1030" x2="1840" y2="1030" stroke="rgba(130, 170, 200, 0.16)" strokeWidth="1" />
        <line x1="80" y1="50" x2="80" y2="1030" stroke="rgba(130, 170, 200, 0.16)" strokeWidth="1" />
        <line x1="1840" y1="50" x2="1840" y2="1030" stroke="rgba(130, 170, 200, 0.16)" strokeWidth="1" />
      </svg>
    </div>
  );
};
