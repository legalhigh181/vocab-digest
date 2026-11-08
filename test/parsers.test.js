import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseByExt, parseBilibiliSubtitleJson, parseDanmakuXml, parseSrt, parseVtt, parseAss } from '../src/parsers.js';

const subtitle = `{"body":[
 {"from":1.5,"to":3.0,"content":"neural network"},
 {"from":4.0,"to":6.0,"content":"gradient descent"},
 {"from":8.0,"to":9.5,"content":"   "}
]}`;

test('B 站字幕 JSON：读 body[].from/content，跳过空文本', () => {
  const { fragments, warnings } = parseBilibiliSubtitleJson(subtitle, 'a.json');
  assert.equal(fragments.length, 2);
  assert.equal(fragments[0].text, 'neural network');
  assert.equal(fragments[0].t, 1.5);
  assert.equal(fragments[0].kind, 'subtitle');
  assert.deepEqual(warnings, []);
});

test('B 站字幕 JSON：坏 JSON 只记 warning 不抛', () => {
  const { fragments, warnings } = parseBilibiliSubtitleJson('{oops', 'bad.json');
  assert.equal(fragments.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'error');
});

test('弹幕 XML：取 p 属性第一段为时间，剥内层标签与实体', () => {
  const xml = '<?xml version="1.0"?><i><d p="12.34,1,25,16777215">hello &amp; world</d><d p="99.0,1,25,0">x</d></i>';
  const { fragments } = parseDanmakuXml(xml, 'd.xml');
  assert.equal(fragments.length, 2);
  assert.equal(fragments[0].t, 12.34);
  assert.equal(fragments[0].text, 'hello & world');
  assert.equal(fragments[0].kind, 'danmaku');
});

test('SRT：时间轴 + 多行合并 + 剥 <i>', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,000\n<i>first line</i>\nsecond\n\n2\n00:00:05,500 --> 00:00:07,000\nthird\n';
  const { fragments } = parseSrt(srt, 'a.srt');
  assert.equal(fragments.length, 2);
  assert.equal(fragments[0].t, 1);
  assert.equal(fragments[0].text, 'first line second');
  assert.equal(fragments[1].t, 5.5);
});

test('VTT：跳过 NOTE 块', () => {
  const vtt = 'WEBVTT\n\nNOTE ignore me\n\n00:00:01.000 --> 00:00:02.000\nhello there\n';
  const { fragments, warnings } = parseVtt(vtt, 'a.vtt');
  assert.equal(warnings.length, 0);
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].text, 'hello there');
});

test('ASS：Text 列含逗号时不被截断', () => {
  const ass = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}hello, world{\\i0}',
  ].join('\n');
  const { fragments } = parseAss(ass, 'a.ass');
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].text, 'hello, world');
  assert.equal(fragments[0].t, 1);
});

test('parseByExt：未知扩展名返回 error warning', () => {
  const { fragments, warnings } = parseByExt('pdf', 'x', 'a.pdf');
  assert.equal(fragments.length, 0);
  assert.equal(warnings[0].level, 'error');
});
