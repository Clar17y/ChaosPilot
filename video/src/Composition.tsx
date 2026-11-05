import React from 'react';
import { Series, useCurrentFrame } from 'remotion';
import { SCENE_DURATIONS } from './theme';
import { TelemetryBackground } from './components/TelemetryBackground';
import { HeaderBar } from './components/HeaderBar';
import { BottomBar } from './components/BottomBar';

import { Scene01_Title } from './scenes/Scene01_Title';
import { Scene02_OrderOfEvents } from './scenes/Scene02_OrderOfEvents';
import { Scene03_SixStageFlow } from './scenes/Scene03_SixStageFlow';
import { Scene04_BriefRequirements } from './scenes/Scene04_BriefRequirements';
import { Scene05_BoundedPlan } from './scenes/Scene05_BoundedPlan';
import { Scene06_ProposeSequence } from './scenes/Scene06_ProposeSequence';
import { Scene07_ExecuteFreshState } from './scenes/Scene07_ExecuteFreshState';
import { Scene08_DuplicateNotTwice } from './scenes/Scene08_DuplicateNotTwice';
import { Scene09_ReplayCompare } from './scenes/Scene09_ReplayCompare';
import { Scene10_ChainOfEvidence } from './scenes/Scene10_ChainOfEvidence';
import { Scene11_BaselinesVsExplore } from './scenes/Scene11_BaselinesVsExplore';
import { Scene12_SyntheticAdapters } from './scenes/Scene12_SyntheticAdapters';
import { Scene13_EvidenceLimitations } from './scenes/Scene13_EvidenceLimitations';
import { Scene14_Outro } from './scenes/Scene14_Outro';

export const ChaosPilotOverview: React.FC = () => {
  const absoluteFrame = useCurrentFrame();
  return (
    <div
      style={{
        position: 'relative',
        width: 1920,
        height: 1080,
        backgroundColor: '#060a10',
        overflow: 'hidden',
      }}
    >
      {/* Permanent Telemetry Background Grid & Radial Glow */}
      <TelemetryBackground />

      {/* Sequenced Scenes */}
      <Series>
        {/* Scene 1: 0-10s (300 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene01}>
          <Scene01_Title />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="CHAOSPILOT // INVESTIGATE NEGATIVE SCENARIOS" />
        </Series.Sequence>

        {/* Scene 2: 10-24s (420 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene02}>
          <HeaderBar sceneTitle="ORDER OF EVENTS" chapterNumber={2} />
          <Scene02_OrderOfEvents />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="ILLUSTRATIVE SEQUENCE // DELAYS, DUPLICATES & REORDERING" />
        </Series.Sequence>

        {/* Scene 3: 24-36s (360 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene03}>
          <HeaderBar sceneTitle="LIFECYCLE PIPELINE" chapterNumber={3} />
          <Scene03_SixStageFlow />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="WORKFLOW OVERVIEW // HYPOTHESIS TO REPRODUCTION" />
        </Series.Sequence>

        {/* Scene 4: 36-50s (420 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene04}>
          <HeaderBar sceneTitle="BRIEF & REQUIREMENTS" chapterNumber={4} />
          <Scene04_BriefRequirements />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="ILLUSTRATIVE BRIEF // REQUIREMENTS NEED EXECUTABLE CHECKS" />
        </Series.Sequence>

        {/* Scene 5: 50-64s (420 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene05}>
          <HeaderBar sceneTitle="PREPARE INVESTIGATION" chapterNumber={5} />
          <Scene05_BoundedPlan />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="ILLUSTRATIVE PLAN // PLANNED AND EXERCISED ARE DISTINCT" />
        </Series.Sequence>

        {/* Scene 6: 64-78s (420 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene06}>
          <HeaderBar sceneTitle="PROPOSE SEQUENCE" chapterNumber={6} />
          <Scene06_ProposeSequence />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="ILLUSTRATIVE PROPOSAL // SOURCE AND CONTRACT IN CONTEXT" />
        </Series.Sequence>

        {/* Scene 7: 78-94s (480 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene07}>
          <HeaderBar sceneTitle="EXECUTE FROM FRESH STATE" chapterNumber={7} />
          <Scene07_ExecuteFreshState />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="ILLUSTRATIVE EXECUTION // FRESH DETERMINISTIC INSTANCE" />
        </Series.Sequence>

        {/* Scene 8: 94-108s (420 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene08}>
          <HeaderBar sceneTitle="INVARIANT FAILURE CHECK" chapterNumber={8} />
          <Scene08_DuplicateNotTwice />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="ILLUSTRATIVE TRADING EXAMPLE // DUPLICATE EXECUTION" />
        </Series.Sequence>

        {/* Scene 9: 108-122s (420 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene09}>
          <HeaderBar sceneTitle="REPLAY & CLEAN CONTROL" chapterNumber={9} />
          <Scene09_ReplayCompare />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="ILLUSTRATIVE COMPARISON // REPLAY AND CLEAN CONTROL" />
        </Series.Sequence>

        {/* Scene 10: 122-134s (360 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene10}>
          <HeaderBar sceneTitle="CHAIN OF EVIDENCE" chapterNumber={10} />
          <Scene10_ChainOfEvidence />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="SAVED EVIDENCE // TRACE, SNAPSHOTS, SOURCE AND CHECKS" />
        </Series.Sequence>

        {/* Scene 11: 134-146s (360 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene11}>
          <HeaderBar sceneTitle="BASELINES & EXPLORATION" chapterNumber={11} />
          <Scene11_BaselinesVsExplore />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="FUNCTIONAL BASELINES // NO AI MODEL CALLS" />
        </Series.Sequence>

        {/* Scene 12: 146-158s (360 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene12}>
          <HeaderBar sceneTitle="SYNTHETIC ADAPTERS" chapterNumber={12} />
          <Scene12_SyntheticAdapters />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="SYNTHETIC ADAPTERS // EXTERNAL TARGETS NEED INTEGRATION" />
        </Series.Sequence>

        {/* Scene 13: 158-170s (360 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene13}>
          <HeaderBar sceneTitle="EVIDENCE BOUNDARIES" chapterNumber={13} />
          <Scene13_EvidenceLimitations />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="EVIDENCE BOUNDARIES // SCRIPTED MOCKS ARE LABELLED" />
        </Series.Sequence>

        {/* Scene 14: 170-180s (300 frames) */}
        <Series.Sequence durationInFrames={SCENE_DURATIONS.scene14}>
          <Scene14_Outro />
          <BottomBar absoluteFrame={absoluteFrame} provenanceText="CHAOSPILOT // ASK WHAT CAN FAIL. KEEP THE EVIDENCE." />
        </Series.Sequence>
      </Series>
    </div>
  );
};
