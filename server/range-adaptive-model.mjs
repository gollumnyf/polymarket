// Frozen on chronological validation; holdout was not used to choose routes.
export const ADAPTIVE_MODEL=Object.freeze({
  "id": "RA-01",
  "datasetHash": "c499a6e6f7d853a2ab060f1df8a2511aea899a6d69eaed111550cf33891ee974",
  "seconds": 60,
  "minMove": 0,
  "routes": {
    "trend:below": "aligned",
    "trend:support": "early",
    "trend:middle": "streak",
    "range:support": "aligned",
    "range:middle": "aligned",
    "range:resistance": "early",
    "mixed:support": "early",
    "mixed:middle": "early",
    "mixed:resistance": "early"
  },
  "holdout": {
    "n": 190,
    "wins": 107,
    "losses": 83,
    "winRate": 0.5631578947368421,
    "coverage": 0.6148867313915858,
    "interval95": [
      0.4920701642323019,
      0.6317422681867454
    ],
    "maxLossStreak": 7,
    "byDay": {
      "2026-11-16": {
        "n": 74,
        "wins": 43
      },
      "2026-11-17": {
        "n": 116,
        "wins": 64
      }
    }
  },
  "train": {
    "n": 592,
    "wins": 410,
    "losses": 182,
    "winRate": 0.6925675675675675,
    "coverage": 0.64,
    "interval95": [
      0.6542545072609292,
      0.728397526433932
    ],
    "maxLossStreak": 5,
    "byDay": {
      "2026-11-10": {
        "n": 80,
        "wins": 55
      },
      "2026-11-11": {
        "n": 138,
        "wins": 94
      },
      "2026-11-12": {
        "n": 140,
        "wins": 101
      },
      "2026-11-13": {
        "n": 122,
        "wins": 78
      },
      "2026-11-14": {
        "n": 80,
        "wins": 58
      },
      "2026-11-15": {
        "n": 32,
        "wins": 24
      }
    }
  },
  "validation": {
    "n": 194,
    "wins": 132,
    "losses": 62,
    "winRate": 0.6804123711340206,
    "coverage": 0.627831715210356,
    "interval95": [
      0.6118350458582188,
      0.7419833624037443
    ],
    "maxLossStreak": 4,
    "byDay": {
      "2026-11-15": {
        "n": 92,
        "wins": 57
      },
      "2026-11-16": {
        "n": 102,
        "wins": 75
      }
    }
  },
  "first": 1794272700,
  "last": 1794900300
});
