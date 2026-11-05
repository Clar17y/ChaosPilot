import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { THEME } from '../theme';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';

export const Scene02_OrderOfEvents: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleSpring = spring({ frame, fps, config: { damping: 15 } });

  const packets = [
    { id: 'PKT-1', label: '1. New Order', sub: 'submit and accept', color: THEME.colors.accentCyan, delay: 30 },
    { id: 'PKT-2', label: '2. Execution Report', sub: 'first delivery', color: THEME.colors.accentGreen, delay: 80 },
    { id: 'PKT-3', label: '3. Duplicate Report', sub: 'same execution identity', color: THEME.colors.accentRed, delay: 140 },
    { id: 'PKT-4', label: '4. Retry / Recovery', sub: 'repeat or delay delivery', color: THEME.colors.accentAmber, delay: 200 },
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
      {/* Editorial Header */}
      <div style={{ opacity: titleSpring, transform: `translateY(${interpolate(titleSpring, [0, 1], [20, 0])}px)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <Badge label="ASYNCHRONOUS COMPLEXITY" variant="cyan" />
          <Badge label="ILLUSTRATIVE SEQUENCE" variant="dim" />
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
          The order of events changes everything.
        </h2>
        <p
          style={{
            fontFamily: THEME.fonts.sans,
            fontSize: 32,
            color: THEME.colors.textMuted,
            marginTop: 14,
            maxWidth: 1200,
            lineHeight: 1.45,
          }}
        >
          Delays, duplicate arrivals, and reordered messages expose critical failures in distributed event streams.
        </p>
      </div>

      {/* Animated Sequence Packets Timeline */}
      <div style={{ position: 'relative', marginTop: 30, marginBottom: 40 }}>
        {/* Connecting bus line */}
        <div
          style={{
            position: 'absolute',
            top: 60,
            left: 40,
            right: 40,
            height: 4,
            backgroundColor: 'rgba(130, 170, 200, 0.2)',
            borderRadius: 2,
            zIndex: 1,
          }}
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 24,
            position: 'relative',
            zIndex: 2,
          }}
        >
          {packets.map((pkt, idx) => {
            const pktSpring = spring({
              frame: frame - pkt.delay,
              fps,
              config: { damping: 14 },
            });
            const isVisible = frame >= pkt.delay;
            const progress = isVisible ? pktSpring : 0;

            return (
              <div
                key={idx}
                style={{
                  opacity: progress,
                  transform: `translateY(${interpolate(progress, [0, 1], [30, 0])}px)`,
                }}
              >
                <Card
                  variant="surface"
                  borderColor={pkt.color}
                  style={{
                    borderTop: `4px solid ${pkt.color}`,
                    height: 220,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span
                        style={{
                          fontFamily: THEME.fonts.mono,
                          fontSize: 16,
                          color: THEME.colors.textDim,
                        }}
                      >
                        {pkt.id}
                      </span>
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          backgroundColor: pkt.color,
                          boxShadow: `0 0 10px ${pkt.color}`,
                        }}
                      />
                    </div>
                    <div
                      style={{
                        fontFamily: THEME.fonts.sans,
                        fontSize: 26,
                        fontWeight: 700,
                        color: THEME.colors.textMain,
                        marginTop: 16,
                      }}
                    >
                      {pkt.label}
                    </div>
                  </div>

                  <div
                    style={{
                      fontFamily: THEME.fonts.mono,
                      fontSize: 18,
                      color: pkt.color,
                      backgroundColor: 'rgba(0,0,0,0.3)',
                      padding: '8px 12px',
                      borderRadius: 6,
                    }}
                  >
                    {pkt.sub}
                  </div>
                </Card>
              </div>
            );
          })}
        </div>
      </div>

      {/* Observation Callout Bar */}
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
        <span style={{ fontFamily: THEME.fonts.sans, fontSize: 24, color: THEME.colors.textMain }}>
          <strong style={{ color: THEME.colors.accentAmber }}>Risk Scenario:</strong> Retransmission during session reconnect can cause double-fill accounting if idempotency invariants fail.
        </span>
        <Badge label="INVARIANT CHECK REQUIRED" variant="amber" size="sm" />
      </Card>
    </div>
  );
};
