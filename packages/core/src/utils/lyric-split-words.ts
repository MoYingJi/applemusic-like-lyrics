import type { LyricWord } from "../interfaces.ts";
import { LyricLineBase } from "../lyric-player/base/line.ts";
import { isCJK } from "./is-cjk.ts";

const SPLIT_WHITESPACE_RE = /(\s+)/;
const WHITESPACE_RE = /\s/g;

/**
 * 按词语边界组合动画，让同一词内的长音错峰上浮并保留逐字高亮时间
 * @param words - 带有时间戳的歌词音节
 * @returns 保留音节边界的词语分组
 */
export function chunkAndSplitLyricWords(
	words: LyricWord[],
): (LyricWord | LyricWord[])[] {
	const atoms: LyricWord[] = [];

	for (const w of words) {
		const content = w.word.trim();
		const isSpace = content.length === 0;
		const romanWord = w.romanWord ?? "";
		const obscene = w.obscene ?? false;
		const hasRuby = (w.ruby?.length ?? 0) > 0;

		if (isSpace) {
			atoms.push({ ...w, obscene });
			continue;
		}

		if (hasRuby) {
			const leadingSpaceMatch = w.word.match(/^\s+/);
			const trailingSpaceMatch = w.word.match(/\s+$/);
			const leadingSpace = leadingSpaceMatch ? leadingSpaceMatch[0] : "";
			const trailingSpace = trailingSpaceMatch ? trailingSpaceMatch[0] : "";

			if (leadingSpace) {
				atoms.push({
					word: leadingSpace,
					romanWord: "",
					startTime: w.startTime,
					endTime: w.startTime,
					obscene: obscene,
				});
			}

			atoms.push({
				...w,
				word: content,
				obscene: obscene,
			});

			if (trailingSpace) {
				atoms.push({
					word: trailingSpace,
					romanWord: "",
					startTime: w.endTime,
					endTime: w.endTime,
					obscene: obscene,
				});
			}
			continue;
		}

		const parts = w.word.split(SPLIT_WHITESPACE_RE).filter((p) => p.length > 0);

		const totalLength = w.word.replace(WHITESPACE_RE, "").length || 1;
		const timeSpan = w.endTime - w.startTime;
		const timePerUnit = timeSpan / totalLength;

		const wordParts = w.word
			.trim()
			.split(/\s+/)
			.filter((p) => p.length > 0);
		const romanTrimmed = romanWord.trim();
		const romanParts =
			romanTrimmed.length > 0
				? romanTrimmed.split(/\s+/).filter((p) => p.length > 0)
				: [];
		const isMatched =
			wordParts.length > 0 && wordParts.length === romanParts.length;

		let currentOffset = 0;
		let nonSpaceIndex = 0;

		for (const part of parts) {
			if (!part.trim()) {
				const startTime = w.startTime + currentOffset * timePerUnit;
				atoms.push({
					word: part,
					romanWord: "",
					startTime: startTime,
					endTime: startTime,
					obscene: obscene,
				});
				continue;
			}

			let partRomanWord = "";
			if (romanParts.length > 0) {
				if (isMatched) {
					partRomanWord = romanParts[nonSpaceIndex] ?? "";
				} else if (nonSpaceIndex === 0) {
					partRomanWord = romanWord;
				}
			}
			nonSpaceIndex++;

			if (isCJK(part) && part.length > 1 && romanTrimmed.length === 0) {
				const chars = part.split("");
				for (const char of chars) {
					const startTime = w.startTime + currentOffset * timePerUnit;
					atoms.push({
						word: char,
						romanWord: "",
						startTime: startTime,
						endTime: startTime + timePerUnit,
						obscene: obscene,
					});
					currentOffset += 1;
				}
			} else {
				const partRealLen = part.length;
				const startTime = w.startTime + currentOffset * timePerUnit;
				const duration = partRealLen * timePerUnit;

				atoms.push({
					word: part,
					romanWord: partRomanWord,
					startTime: startTime,
					endTime: startTime + duration,
					obscene: obscene,
				});
				currentOffset += partRealLen;
			}
		}
	}

	const segmenter = LyricLineBase.wordSegmenter;
	if (!segmenter) return atoms;

	const result: (LyricWord | LyricWord[])[] = [];
	const fullText = atoms.map((atom) => atom.word).join("");
	let atomIndex = 0;
	let expectedLength = 0;
	let actualLength = 0;
	let currentGroup: LyricWord[] = [];

	for (const { segment } of segmenter.segment(fullText)) {
		expectedLength += segment.length;
		while (actualLength < expectedLength && atomIndex < atoms.length) {
			const atom = atoms[atomIndex++];
			currentGroup.push(atom);
			actualLength += atom.word.length;
		}

		// 不拆开带独立时间戳或注音的音节，等分词边界与音节边界重合再分组
		if (actualLength !== expectedLength) continue;

		while (currentGroup.length > 1 && !currentGroup[0].word.trim()) {
			const leadingSpace = currentGroup.shift();
			if (leadingSpace) result.push(leadingSpace);
		}
		if (currentGroup.length > 0) {
			result.push(currentGroup.length === 1 ? currentGroup[0] : currentGroup);
		}
		currentGroup = [];
	}

	if (currentGroup.length > 0) {
		result.push(currentGroup.length === 1 ? currentGroup[0] : currentGroup);
	}

	return result;
}
