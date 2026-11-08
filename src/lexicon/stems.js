/**
 * 弱后缀（-er / -ly / -ment / -tion …）的词典判定。
 *
 * 为什么需要这一层：强后缀（-s/-ed/-ing）裁完直接接受就行，
 * 但 -er 可能是「cleaner 清洁工」也可能是「clean 的比较级」，
 * 只有候选词在词典里才敢裁。而种子词典只有 1500 词左右，
 * 所以这里再加一层「合法词根表」—— 命中就当作词典里有。
 */

/** 常见词根（去掉弱后缀后的原形），覆盖技术/学术视频里高频出现的词 */
export const STEM_WHITELIST = new Set(`
  clean read write teach learn help work play walk talk look watch listen speak
  quick slow kind hard soft loud bright dark light weight deep height wide
  large small simple normal usual actual final total general special natural
  direct correct clear obvious serious careful useful helpful powerful
  effective efficient important different similar certain recent previous
  free happy easy busy angry hungry sleepy healthy likely unlike alone
  process access success progress express impress discuss
  train transform translate transfer transport
  convert compute model predict classify detect generate
  optimize optimize regular normal minimize maximize
  represent describe explain maintain contain obtain
  perform inform reason season person lesson
  build create design define measure adjust behave improve
  manage arrange develop involve react act adapt adopt
  collect connect construct contribute
  examine combine compare compete complete
  decide divide provide remove require restore resolve
  modify notify occupy satisfy verify
  organize memorize stabilize normalize regularize

  add set get let put run use make take give
  find keep hold show move turn call need feel seem
  reach watch match catch touch laugh
  drop step stop plan map fit sit cut hit
  count mount point print start end
`.split(/\s+/).filter(Boolean));

/** 判断候选词根是否可信（有词典就查词典，没有就看白名单） */
export function makeDictCheck(dictionary) {
  const dict = dictionary instanceof Set ? dictionary : new Set(dictionary ?? []);
  const hasDict = dict.size > 0;
  return (w) => (hasDict ? dict.has(w) || STEM_WHITELIST.has(w) : true);
}
