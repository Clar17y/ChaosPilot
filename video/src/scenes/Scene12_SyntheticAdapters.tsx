import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene12_SyntheticAdapters: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 15 } });

  const systems = [
    {
      title: 'Trading Systems',
      desc: 'Order admission, execution reports, and credit accounting',
      color: THEME.colors.accentCyan,
      tag: 'SYNTHETIC ADAPTER',
    },
    {
      title: 'Inventory Reservations',
      desc: 'Reservation lifecycle, stock conservation, and retry behaviour',
      color: THEME.colors.accentAmber,
      tag: 'SYNTHETIC ADAPTER',
    },
    {
      title: 'Report Recovery',
      desc: 'Accepted reports during disconnection, recovery, and duplicate delivery',
      color: THEME.colors.accentViolet,
      tag: 'SYNTHETIC ADAPTER',
    },
  ];

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 1920,
        height: 1080,
        padding: '120px 120px 80px 120px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      {/* Header */}
      <div style={{ opacity: titleSpring, transform: `translateY(${interpolate(titleSpring, [0, 1], [20, 0])}px)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <Badge label="EXTENSIBLE ADAPTER PATTERNS" variant="cyan" />
          <Badge label="LOCAL DETERMINISTIC TESTBEDS" variant="dim" />
        </div>
        <h2
          style={{
            fontFamily: THEME.fonts.sans,
            fontSize: 68,
            fontWeight: 800,
            letterSpacing: '-0.02em',
            color: THEME.colors.textMain,
            lineHeight: 1.1,
            margin: 0,
          }}
        >
          More than one kind of system.
        </h2>
        <p
          style={{
            fontFamily: THEME.fonts.sans,
            fontSize: 32,
            color: THEME.colors.textMuted,
            marginTop: 14,
            maxWidth: 1300,
            lineHeight: 1.45,
          }}
        >
          Existing synthetic adapters demonstrate core event patterns. Connecting another system requires a dedicated execution adapter.
        </p>
      </div>

      {/* 3 Synthetic Adapters */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 24,
          margin: '20px 0',
        }}
      >
        {systems.map((sys, idx) => {
          const sysSpring = spring({
            frame: frame - (20 + idx * 30),
            fps,
            config: { damping: 14 },
          });
          const prog = frame >= 20 + idx * 30 ? sysSpring : 0;

          return (
            <div
              key={idx}
              style={{
                opacity: prog,
                transform: `translateY(${interpolate(prog, [0, 1], [25, 0])}px)`,
              }}
            >
              <Card
                variant="surface"
                borderColor={sys.color}
                style={{
                  borderTop: `4px solid ${sys.color}`,
                  height: 220,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <Badge label={sys.tag} variant="dim" size="sm" />
                  </div>
                  <div style={{ fontFamily: THEME.fonts.sans, fontSize: 26, fontWeight: 750, color: THEME.colors.textMain }}>
                    {sys.title}
                  </div>
                </div>

                <div style={{ fontFamily: THEME.fonts.sans, fontSize: 18, color: THEME.colors.textMuted, lineHeight: 1.45 }}>
                  {sys.desc}
                </div>
              </Card>
            </div>
          );
        })}
      </div>

      {/* External Integration Notice */}
      <Card
        variant="raised"
        style={{
          borderLeft: `4px solid ${THEME.colors.accentAmber}`,
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontFamily: THEME.fonts.sans, fontSize: 22, color: THEME.colors.textMain }}>
          <strong style={{ color: THEME.colors.accentAmber }}>Integration Boundary:</strong> Connecting an external system requires an execution adapter with its own contract and checks.
        </span>
        <Badge label="CUSTOM ADAPTER REQUIRED FOR EXTERNAL" variant="amber" size="sm" />
      </Card>
    </div>
  );
};
