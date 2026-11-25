import type { DominoDocument, Piece } from './document'

const domino = (id: string, x: number, y: number, angle: number, label: string): Piece => ({
  id, kind: 'domino', x, y, angle, facing: 'east', label, height: 1.6, width: 0.42,
  fallThreshold: 0.8, friction: 0.55,
})

export function createDefaultDocument(): DominoDocument {
  const pieces: Piece[] = [
    {
      ...domino('p1', 0.9, 4.2, 0, '摆锤'), kind: 'pendulum', width: 0.6, height: 1.1,
      energyJ: 44, startAngleDeg: 38, fallThreshold: 0.4,
    },
    domino('d1', 2, 4.2, 0, '起点'),
    domino('d2', 3.6, 4.2, 0, '03'),
    domino('d3', 5.2, 4.2, 0, '04'),
    domino('d4', 6.8, 4.2, 0, '05'),
    domino('d5', 8.4, 4.2, 0, '06'),
    { ...domino('r1', 10.2, 4.2, 0, '上坡'), kind: 'ramp', width: 1.7, height: 0.45 },
    domino('d6', 12.1, 3.55, -20, '08'),
    { ...domino('s1', 13.7, 3.15, 20, '分岔'), kind: 'splitter', width: 0.75 },
    domino('d7', 15.2, 2.3, 0, '10'),
    domino('d8', 16.8, 2.3, 0, '11'),
    domino('d9', 15.2, 4.05, 0, '12'),
    domino('d10', 16.8, 4.05, 0, '13'),
    { ...domino('t1', 18.4, 2.3, 0, '终点 A'), kind: 'trigger', width: 0.7 },
  ]
  return {
    id: 'chainline-starter',
    title: '逆风转角',
    revision: 1,
    updatedAt: Date.now(),
    pieces,
    connections: [
      { id: 'c1', from: 's1', to: 'd7', delay: 0.15, enabled: true },
      { id: 'c2', from: 's1', to: 'd9', delay: 0.15, enabled: true },
    ],
    scene: { gravity: 9.8, friction: 0.62, width: 21, height: 9, showGrid: true },
    startPieceId: 'p1',
  }
}

/**
 * The audited demonstration scene:
 * pendulum → driver → ramp (stores, then releases) → splitter hub →
 * two equal-delay branches → both arms strike one domino at the same instant →
 * a short tail that finally runs out of reachable parts.
 */
export function createEnergyVerificationDocument(): DominoDocument {
  const pieces: Piece[] = [
    {
      ...domino('p1', 1.6, 4.2, 0, '摆锤'), kind: 'pendulum', width: 0.62, height: 1.2,
      energyJ: 96, startAngleDeg: 42, fallThreshold: 0.4,
    },
    domino('d1', 3.1, 4.2, 0, '传导'),
    { ...domino('r1', 4.9, 4.2, 0, '储能坡'), kind: 'ramp', width: 1.7, height: 0.45 },
    { ...domino('s1', 7.0, 4.2, 0, '坡顶枢纽'), kind: 'splitter', width: 0.75 },
    domino('a1', 8.7, 2.9, 22, '左臂'),
    domino('a2', 8.7, 5.5, -22, '右臂'),
    domino('m1', 10.15, 4.2, 0, '合流牌'),
    domino('m2', 11.7, 4.2, 0, '尾牌'),
    domino('m3', 13.4, 6.4, 0, '孤立牌'),
  ]
  return {
    id: 'chainline-energy-verification',
    title: '能量验证 · 摆锤分岔',
    revision: 1,
    updatedAt: Date.now(),
    pieces,
    connections: [
      { id: 'ev1', from: 's1', to: 'a1', delay: 0.15, enabled: true },
      { id: 'ev2', from: 's1', to: 'a2', delay: 0.15, enabled: true },
    ],
    scene: { gravity: 9.8, friction: 0.62, width: 21, height: 9, showGrid: true },
    startPieceId: 'p1',
  }
}

export interface ScenarioOption {
  id: string
  title: string
  hint: string
  create: () => DominoDocument
}

export const scenarioOptions: ScenarioOption[] = [
  {
    id: 'starter',
    title: '逆风转角',
    hint: '机关连线分岔的入门布局',
    create: createDefaultDocument,
  },
  {
    id: 'energy-verification',
    title: '能量验证 · 摆锤分岔',
    hint: '摆锤 → 坡道储能 → 分岔枢纽 → 双支路同刻触碰 → 中断',
    create: createEnergyVerificationDocument,
  },
]
