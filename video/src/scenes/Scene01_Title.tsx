import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';

export const Scene01_Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Intro fade/scale spring
  const introSpring = spring({
    frame,
    fps,
    config: { damping: 14, stiffness: 70 },
  });

  // Packets converging inwards
  const packetProgress = interpolate(frame, [15, 120], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const taglineOpacity = interpolate(frame, [80, 110], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const sublineOpacity = interpolate(frame, [120, 150], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Events that converge
  const events = [
    { name: 'OrderPlaced[seq=101]', color: THEME.colors.accentCyan, startX: -550, startY: -180 },
    { name: 'ExecutionReport[qty=50]', color: THEME.colors.accentGreen, startX: 550, startY: -140 },
    { name: 'DuplicateReport[seq=101]', color: THEME.colors.accentRed, startX: -520, startY: 160 },
    { name: 'HeartbeatTimeout[node=B]', color: THEME.colors.accentAmber, startX: 520, startY: 180 },
    { name: 'PartitionInjected[dur=200ms]', color: THEME.colors.accentViolet, startX: 0, startY: -280 },
    { name: 'CancelRequest[id=994]', color: THEME.colors.accentCyan, startX: 0, startY: 280 },
  ];

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 1920,
        height: 1080,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Converging Event Stream Packets */}
      {events.map((evt, idx) => {
        const curX = interpolate(packetProgress, [0, 1], [evt.startX, 0]);
        const curY = interpolate(packetProgress, [0, 1], [evt.startY, 0]);
        const packetOpacity = interpolate(
          packetProgress,
          [0, 0.2, 0.85, 1],
          [0, 0.8, 0.8, 0]
        );

        return (
          <div
            key={idx}
            style={{
              position: 'absolute',
              transform: `translate(${curX}px, ${curY}px)`,
              opacity: packetOpacity,
              backgroundColor: THEME.colors.bgSurface,
              border: `1.5px solid ${evt.color}`,
              borderRadius: 8,
              padding: '8px 16px',
              fontFamily: THEME.fonts.mono,
              fontSize: 18,
              fontWeight: 600,
              color: evt.color,
              boxShadow: `0 0 20px ${evt.color}33`,
              pointerEvents: 'none',
              zIndex: 5,
            }}
          >
            {evt.name}
          </div>
        );
      })}

      {/* Central Core Telemetry Ring */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${0.9 + introSpring * 0.1})`,
          zIndex: 10,
        }}
      >
        {/* Subtle Category Pill */}
        <div style={{ marginBottom: 24, opacity: introSpring }}>
          <Badge label="NEGATIVE SCENARIO WORKBENCH" variant="cyan" />
        </div>

        {/* Product Headline */}
        <h1
          style={{
            fontFamily: THEME.fonts.sans,
            fontSize: 96,
            fontWeight: 800,
            letterSpacing: '-0.03em',
            color: THEME.colors.textMain,
            lineHeight: 1.05,
            margin: 0,
            textShadow: '0 0 40px rgba(105, 199, 219, 0.35)',
          }}
        >
          ChaosPilot
        </h1>

        {/* Primary Tagline */}
        <div
          style={{
            marginTop: 24,
            opacity: taglineOpacity,
            fontFamily: THEME.fonts.sans,
            fontSize: 42,
            fontWeight: 600,
            color: THEME.colors.accentBright,
            letterSpacing: '-0.01em',
          }}
        >
          Find the failure. Keep the evidence.
        </div>

        {/* Subline */}
        <div
          style={{
            marginTop: 18,
            opacity: sublineOpacity,
            fontFamily: THEME.fonts.sans,
            fontSize: 28,
            color: THEME.colors.textMuted,
            maxWidth: 900,
            textAlign: 'center',
            lineHeight: 1.4,
          }}
        >
          Investigate negative scenarios in event-driven software.
        </div>
      </div>
    </div>
  );
};
