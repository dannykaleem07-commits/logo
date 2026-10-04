import type { GuidedShot } from '@ccguk/domain';
import { outlineKind, SHOT_LABEL } from './capture';

/** Dashed framing outline drawn over the live camera view for the current shot (viewBox 100 × 75, 4:3). */
export function ShotOverlay({ shot }: { shot: GuidedShot }) {
  const kind = outlineKind(shot);
  return (
    <svg className="cap-overlay" viewBox="0 0 100 75" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <Outline kind={kind} />
      <text x="50" y="6" textAnchor="middle">
        {SHOT_LABEL[shot]}
      </text>
    </svg>
  );
}

function Outline({ kind }: { kind: ReturnType<typeof outlineKind> }) {
  switch (kind) {
    case 'car_front_left':
    case 'car_front_right':
    case 'car_rear_left':
    case 'car_rear_right': {
      // Three-quarter car silhouette; mirrored for right-hand corners, labelled front/rear by the text above.
      const mirror = kind.endsWith('_right') ? 'translate(100 0) scale(-1 1)' : undefined;
      return (
        <g transform={mirror}>
          <path className="outline" d="M12 52 L14 40 Q16 32 26 30 L36 22 Q44 17 56 17 L74 17 Q84 17 88 26 L92 38 Q94 52 90 56 L84 58 A7 7 0 0 1 70 58 L34 58 A7 7 0 0 1 20 58 L14 57 Z" />
          <circle className="guide" cx="27" cy="58" r="6" />
          <circle className="guide" cx="77" cy="58" r="6" />
          <path className="guide" d="M30 30 L40 23 L56 23 L58 30 Z" />
          <line className="guide" x1="8" y1="66" x2="92" y2="66" />
        </g>
      );
    }
    case 'plate':
      return (
        <g>
          <rect className="outline" x="20" y="31" width="60" height="13" rx="1.5" />
          <line className="guide" x1="20" y1="37.5" x2="80" y2="37.5" />
        </g>
      );
    case 'vin':
      return (
        <g>
          <rect className="outline" x="22" y="33" width="56" height="9" rx="1" />
          <text x="50" y="50" textAnchor="middle" style={{ fontSize: 3 }}>
            17 characters legible
          </text>
        </g>
      );
    case 'odometer':
      return (
        <g>
          <rect className="outline" x="26" y="28" width="48" height="20" rx="4" />
          <rect className="guide" x="36" y="34" width="28" height="8" rx="1" />
          <text x="50" y="56" textAnchor="middle" style={{ fontSize: 3 }}>
            mileage and units (mi / km) in frame
          </text>
        </g>
      );
    case 'damage':
      return (
        <g>
          <circle className="outline" cx="50" cy="38" r="22" />
          <line className="guide" x1="50" y1="12" x2="50" y2="64" />
          <line className="guide" x1="24" y1="38" x2="76" y2="38" />
          <text x="50" y="68" textAnchor="middle" style={{ fontSize: 3 }}>
            about 1 m away, panel edge in frame for scale
          </text>
        </g>
      );
    case 'tyre':
      return (
        <g>
          <circle className="outline" cx="50" cy="38" r="25" />
          <circle className="guide" cx="50" cy="38" r="13" />
          <text x="50" y="70" textAnchor="middle" style={{ fontSize: 3 }}>
            tread face and sidewall
          </text>
        </g>
      );
    case 'interior':
      return (
        <g>
          <rect className="outline" x="8" y="12" width="84" height="52" rx="3" />
          <path className="guide" d="M8 40 Q50 30 92 40" />
          <text x="50" y="70" textAnchor="middle" style={{ fontSize: 3 }}>
            dashboard warning lights, airbags, seats
          </text>
        </g>
      );
  }
}
