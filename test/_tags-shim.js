/**
 * 测试用的轻量再出口：把标签相关 API 从 src 与 src/export 汇总到一处，
 * 免得测试文件到处写两行 import。
 */
import { filterItems } from '../src/export.js';

export {
  DIFFICULTY_LABELS,
  FREQ_BAND_LABELS,
  TAG_DIMENSIONS,
  difficultyTag,
  freqBand,
  groupByTag,
  tagsOf,
} from '../src/classify.js';

export const filterItemsForTest = filterItems;
