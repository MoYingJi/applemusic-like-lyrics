import bezier from "bezier-easing";
import type { LyricLine, LyricWord } from "../../interfaces.ts";
import styles from "../../styles/lyric-player.module.css";
import { isCJK } from "../../utils/is-cjk.ts";
import { chunkAndSplitLyricWords } from "../../utils/lyric-split-words.ts";
import {
	createMatrix4,
	matrix4ToCSS,
	scaleMatrix4,
} from "../../utils/matrix.ts";
import { LyricLineBase } from "../base.ts";
import { LyricLineRenderMode } from "../index.ts";
import type { DomLyricPlayer } from ".";

interface RealWord extends LyricWord {
	mainElement: HTMLSpanElement;
	subElements: HTMLSpanElement[];
	elementAnimations: Animation[];
	maskAnimations: Animation[];
	width: number;
	height: number;
	padding: number;
	shouldEmphasize: boolean;
}

interface LayoutToken {
	node: Node;
	breakPriority: number;
	width: number;
	text: string;
}

const ANIMATION_FRAME_QUANTITY = 32;

const norNum = (min: number, max: number) => (x: number) =>
	Math.min(1, Math.max(0, (x - min) / (max - min)));
const EMP_EASING_MID = 0.5;
const beginNum = norNum(0, EMP_EASING_MID);
const endNum = norNum(EMP_EASING_MID, 1);

const bezIn = bezier(0.2, 0.4, 0.58, 1.0);
const bezOut = bezier(0.3, 0.0, 0.58, 1.0);

const makeEmpEasing = (mid: number) => {
	return (x: number) => (x < mid ? bezIn(beginNum(x)) : 1 - bezOut(endNum(x)));
};

function generateFadeGradient(
	width: number,
	padding = 0,
	bright = "rgba(0,0,0,var(--bright-mask-alpha, 1.0))",
	dark = "rgba(0,0,0,var(--dark-mask-alpha, 1.0))",
): [string, number] {
	const totalAspect = 2 + width + padding;
	const widthInTotal = width / totalAspect;
	const leftPos = (1 - widthInTotal) / 2;
	return [
		`linear-gradient(to right,${bright} ${leftPos * 100}%,${dark} ${
			(leftPos + widthInTotal) * 100
		}%)`,
		totalAspect,
	];
}

export class RawLyricLineMouseEvent extends MouseEvent {
	constructor(
		public readonly line: LyricLineBase,
		event: MouseEvent,
	) {
		super(event.type, event);
	}
}

type MouseEventMap = {
	[evt in keyof HTMLElementEventMap]: HTMLElementEventMap[evt] extends MouseEvent
		? evt
		: never;
};
type MouseEventTypes = MouseEventMap[keyof MouseEventMap];
type MouseEventListener = (
	this: LyricLineEl,
	ev: RawLyricLineMouseEvent,
) => void;

export class LyricLineEl extends LyricLineBase {
	private element: HTMLElement = document.createElement("div");
	private splittedWords: RealWord[] = [];

	private layoutTokens: LayoutToken[] = [];
	private manualLineContainers: HTMLDivElement[] = [];
	private lastMainWidth = 0;

	// 标记是否已经构建了行内的实际 DOM（单词与动画等）
	private built = false;

	// 由 LyricPlayer 来设置
	lineSize: number[] = [0, 0];

	private renderMode = LyricLineRenderMode.SOLID;

	private currentBrightAlpha = 1.0;
	private currentDarkAlpha = 0.2;

	private targetBrightAlpha = 1.0;
	private targetDarkAlpha = 0.2;

	// Unicode 标准的 Grapheme Cluster 分割器
	// 用于正确处理 emoji、复合字符等
	private segmenter = new Intl.Segmenter(undefined, {
		granularity: "grapheme",
	});

	constructor(
		private lyricPlayer: DomLyricPlayer,
		private lyricLine: LyricLine = {
			words: [],
			translatedLyric: "",
			romanLyric: "",
			startTime: 0,
			endTime: 0,
			isBG: false,
			isDuet: false,
		},
	) {
		super();
		this._prevParentEl = lyricPlayer.getElement();
		lyricPlayer.resizeObserver.observe(this.element);
		this.element.setAttribute("class", styles.lyricLine);
		if (this.lyricLine.isBG) {
			this.element.classList.add(styles.lyricBgLine);
		}
		if (this.lyricLine.isDuet) {
			this.element.classList.add(styles.lyricDuetLine);
		}
		this.lineTransforms.posY.setPosition(window.innerHeight * 2);
		this.element.appendChild(document.createElement("div")); // 歌词行
		this.element.appendChild(document.createElement("div")); // 翻译行
		this.element.appendChild(document.createElement("div")); // 音译行
		const main = this.element.children[0] as HTMLDivElement;
		const trans = this.element.children[1] as HTMLDivElement;
		const roman = this.element.children[2] as HTMLDivElement;
		main.setAttribute("class", styles.lyricMainLine);
		trans.setAttribute("class", styles.lyricSubLine);
		roman.setAttribute("class", styles.lyricSubLine);
		// 延迟构建具体行内容，进入可视区（含 overscan）时再构建
		this.rebuildStyle();
	}
	private listenersMap = new Map<string, Set<MouseEventListener>>();
	private readonly onMouseEvent = (e: MouseEvent) => {
		const wrapped = new RawLyricLineMouseEvent(this, e);
		for (const listener of this.listenersMap.get(e.type) ?? []) {
			listener.call(this, wrapped);
		}
		if (!this.dispatchEvent(wrapped) || wrapped.defaultPrevented) {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
		}
	};

	addMouseEventListener(
		type: MouseEventTypes,
		callback: MouseEventListener | null,
		options?: boolean | AddEventListenerOptions | undefined,
	): void {
		if (callback) {
			const listeners = this.listenersMap.get(type) ?? new Set();
			if (listeners.size === 0)
				this.element.addEventListener(type, this.onMouseEvent, options);
			listeners.add(callback);
			this.listenersMap.set(type, listeners);
		}
	}

	removeMouseEventListener(
		type: MouseEventTypes,
		callback: MouseEventListener | null,
		options?: boolean | EventListenerOptions | undefined,
	): void {
		if (callback) {
			const listeners = this.listenersMap.get(type);
			if (listeners) {
				listeners.delete(callback);
				if (listeners.size === 0)
					this.element.removeEventListener(type, this.onMouseEvent, options);
			}
		}
	}

	areWordsOnSameLine(word1: RealWord, word2: RealWord): boolean {
		if (word1?.mainElement && word2?.mainElement) {
			const word1el = word1.mainElement;
			const word2el = word2.mainElement;

			const rect1 = word1el.getBoundingClientRect();
			const rect2 = word2el.getBoundingClientRect();

			// 检查两个单词的顶部距离是否相等（或者差值很小）
			const topDifference = Math.abs(rect1.top - rect2.top);

			// 如果顶部距离相差很小，可以认为它们在同一行上
			return topDifference < 10;
		}

		return true;
	}

	private isEnabled = false;
	async enable(
		maskAnimationTime: number = this.lyricLine.startTime,
		shouldPlay = true,
	): Promise<void> {
		this.isEnabled = true;
		this.element.classList.add(styles.active);
		const main = this.element.children[0] as HTMLDivElement;

		const relativeTime = Math.max(
			0,
			maskAnimationTime - this.lyricLine.startTime,
		);
		const actualMaskTime =
			maskAnimationTime === this.lyricLine.startTime
				? this.lyricPlayer.getCurrentTime()
				: maskAnimationTime;

		const maskRelativeTime = Math.max(
			0,
			actualMaskTime - this.lyricLine.startTime,
		);

		for (const word of this.splittedWords) {
			for (const a of word.elementAnimations) {
				a.currentTime = relativeTime;
				a.playbackRate = 1;

				const timing = a.effect?.getComputedTiming();
				const duration = (timing?.duration as number) || 0;
				const delay = (timing?.delay as number) || 0;
				const endTime = delay + duration;

				if (shouldPlay && relativeTime < endTime) {
					a.play();
				} else {
					a.pause();
				}
			}

			for (const a of word.maskAnimations) {
				const t = Math.min(this.totalDuration, maskRelativeTime);
				a.currentTime = t;
				a.playbackRate = 1;

				const timing = a.effect?.getComputedTiming();
				const duration = (timing?.duration as number) || 0;
				const delay = (timing?.delay as number) || 0;
				const endTime = delay + duration;

				if (shouldPlay && t < endTime) {
					a.play();
				} else {
					a.pause();
				}
			}
		}
		main.classList.add(styles.active);
	}

	disable(): void {
		this.isEnabled = false;
		this.element.classList.remove(styles.active);
		this.renderMode = LyricLineRenderMode.SOLID;

		const main = this.element.children[0] as HTMLDivElement;

		for (const word of this.splittedWords) {
			for (const a of word.elementAnimations) {
				if (
					a.id === "float-word" ||
					a.id.includes("emphasize-word-float-only")
				) {
					a.playbackRate = -1;
					a.play();
				}
			}

			for (const a of word.maskAnimations) {
				a.pause();
			}
		}
		main.classList.remove(styles.active);
	}

	private lastWord?: RealWord;

	async resume(): Promise<void> {
		if (!this.isEnabled) return;
		for (const word of this.splittedWords) {
			for (const a of word.elementAnimations) {
				if (
					!this.lastWord ||
					this.splittedWords.indexOf(this.lastWord) <
						this.splittedWords.indexOf(word)
				) {
					const timing = a.effect?.getComputedTiming();
					const duration = (timing?.duration as number) || 0;
					const delay = (timing?.delay as number) || 0;
					const endTime = delay + duration;
					const currentTime = (a.currentTime as number) || 0;

					if (a.playState !== "finished" && currentTime < endTime) {
						a.play();
					}
				}
			}

			for (const a of word.maskAnimations) {
				if (
					!this.lastWord ||
					this.splittedWords.indexOf(this.lastWord) <
						this.splittedWords.indexOf(word)
				) {
					const timing = a.effect?.getComputedTiming();
					const duration = (timing?.duration as number) || 0;
					const delay = (timing?.delay as number) || 0;
					const endTime = delay + duration;

					const currentTime = (a.currentTime as number) || 0;

					if (a.playState !== "finished" && currentTime < endTime) {
						a.play();
					}
				}
			}
		}
	}

	async pause(): Promise<void> {
		if (!this.isEnabled) return;
		for (const word of this.splittedWords) {
			for (const a of word.elementAnimations) {
				a.pause();
			}
			for (const a of word.maskAnimations) {
				a.pause();
			}
		}
	}
	setMaskAnimationState(maskAnimationTime = 0): void {
		const t = maskAnimationTime - this.lyricLine.startTime;
		for (const word of this.splittedWords) {
			for (const a of word.maskAnimations) {
				a.currentTime = Math.min(this.totalDuration, Math.max(0, t));
				a.playbackRate = 1;
				if (t >= 0 && t < this.totalDuration) a.play();
				else a.pause();
			}
		}
	}

	getLine(): LyricLine {
		return this.lyricLine;
	}
	// private _hide = true;
	private _prevParentEl: HTMLElement;
	private lastStyle = "";
	show(): void {
		// this._hide = false;
		if (!this.element.parentElement) {
			this._prevParentEl.appendChild(this.element);
			this.lyricPlayer.resizeObserver.observe(this.element);
		}
		if (!this.built) {
			this.rebuildElement();
			this.built = true;
			this.updateMaskImageSync();
		}
		this.rebuildStyle();
	}
	hide(): void {
		// this._hide = true;
		if (this.element.parentElement) {
			this._prevParentEl.removeChild(this.element);
			this.lyricPlayer.resizeObserver.unobserve(this.element);
		}
		if (this.built) {
			this.disposeElements();
			this.built = false;
		}
	}
	private rebuildStyle() {
		let style = "";
		// if (this.lyricPlayer.getEnableSpring()) {
		style += `transform:translateY(${this.lineTransforms.posY
			.getCurrentPosition()
			.toFixed(
				1,
			)}px) scale(${(this.lineTransforms.scale.getCurrentPosition() / 100).toFixed(4)});`;
		if (!this.lyricPlayer.getEnableSpring() && this.isInSight) {
			style += `transition-delay:${this.delay}ms;`;
		}
		style += `filter:blur(${Math.min(5, this.blur)}px);`;
		if (style !== this.lastStyle) {
			this.lastStyle = style;
			this.element.setAttribute("style", style);
		}
	}

	override rebuildElement(): void {
		this.disposeElements();
		const main = this.element.children[0] as HTMLDivElement;
		const trans = this.element.children[1] as HTMLDivElement;
		const roman = this.element.children[2] as HTMLDivElement;
		// 非动态歌词，直接渲染整行与副行
		if (this.lyricPlayer._getIsNonDynamic()) {
			const text = this.lyricLine.words
				.map((w) => this.lyricPlayer.processObsceneWord(w))
				.join("");
			this.appendPlainTextTokens(main, text);
			this.applyManualLineBreaks(main);
			this.setSubLinesText(trans, roman);
			return;
		}

		const chunkedWords = chunkAndSplitLyricWords(this.lyricLine.words);
		const hasRubyLine = this.lyricLine.words.some(
			(word) => (word.ruby?.length ?? 0) > 0,
		);
		const hasRomanLine = this.lyricLine.words.some(
			(word) => (word.romanWord?.trim().length ?? 0) > 0,
		);
		main.innerHTML = "";

		for (const chunk of chunkedWords) {
			this.buildWord(chunk, main, hasRubyLine, hasRomanLine);
		}

		this.applyManualLineBreaks(main);
		this.setSubLinesText(trans, roman);
	}

	/** 设置翻译与音译行文本 */
	private setSubLinesText(trans: HTMLDivElement, roman: HTMLDivElement) {
		trans.innerText = this.lyricLine.translatedLyric;
		roman.innerText = this.lyricLine.romanLyric;
	}

	private appendPlainTextTokens(main: HTMLDivElement, text: string) {
		const chunks = text.match(/\s+|\S+/g) ?? [];
		const punctuations =
			this.lyricPlayer.getManualLineBreakConfig().punctuations;

		for (const chunk of chunks) {
			if (chunk.trim().length === 0) {
				const spaceNode = document.createTextNode(chunk);
				main.appendChild(spaceNode);
				this.pushLayoutToken(spaceNode, chunk, 3);
				continue;
			}

			let current = "";
			for (const { segment } of this.segmenter.segment(chunk)) {
				current += segment;
				if (punctuations.includes(segment)) {
					const node = document.createTextNode(current);
					main.appendChild(node);
					this.pushLayoutToken(node, current);
					current = "";
				}
			}

			if (current.length > 0) {
				const node = document.createTextNode(current);
				main.appendChild(node);
				this.pushLayoutToken(node, current);
			}
		}
	}

	private pushLayoutToken(
		node: Node,
		rawText: string,
		breakPriority: number = -1,
	) {
		let priority = breakPriority;
		if (priority === -1) {
			if (rawText.trim().length === 0) {
				// 空格
				priority = 2;
			} else {
				const normalized = rawText.trimEnd();
				const lastChar = normalized.charAt(normalized.length - 1);
				if (lastChar) {
					if (
						this.lyricPlayer
							.getManualLineBreakConfig()
							.punctuations.includes(lastChar)
					) {
						priority = 3;
					}
				}
			}
		}
		this.layoutTokens.push({
			node,
			breakPriority: priority,
			width: 0,
			text: rawText,
		});
	}

	private isWordBoundaryBreakIndex(index: number): boolean {
		if (index >= this.layoutTokens.length - 1) {
			return true;
		}

		const leftText = this.layoutTokens[index].text.trimEnd();
		const rightText = this.layoutTokens[index + 1].text.trimStart();
		const leftChar = leftText.charAt(leftText.length - 1);
		const rightChar = rightText.charAt(0);

		if (!leftChar || !rightChar) {
			return true;
		}

		const punctuations =
			this.lyricPlayer.getManualLineBreakConfig().punctuations;
		if (punctuations.includes(leftChar) || punctuations.includes(rightChar)) {
			return true;
		}

		if (!isCJK(leftChar) && !isCJK(rightChar)) {
			return false;
		}

		return true;
	}

	private getNodeHorizontalPadding(node: Node): number {
		if (!(node instanceof HTMLElement)) return 0;
		const style = getComputedStyle(node);
		const pl = Number.parseFloat(style.paddingLeft) || 0;
		const pr = Number.parseFloat(style.paddingRight) || 0;
		return pl + pr;
	}

	private getMainContentWidth(main: HTMLDivElement): number {
		if (main.clientWidth <= 0) return 0;
		const style = getComputedStyle(main);
		const pl = Number.parseFloat(style.paddingLeft) || 0;
		const pr = Number.parseFloat(style.paddingRight) || 0;
		const contentWidth = main.clientWidth - (pl + pr);
		return Math.max(0, contentWidth);
	}

	private getMainTransformScale(main: HTMLDivElement): number {
		const clientWidth = main.clientWidth;
		if (clientWidth <= 0) return 1;
		const rectWidth = main.getBoundingClientRect().width;
		if (rectWidth <= 0) return 1;
		return rectWidth / clientWidth;
	}

	private maybeReflowManualLineBreak(main?: HTMLDivElement): void {
		const mainLine = (main ?? this.element.children[0]) as
			| HTMLDivElement
			| undefined;
		if (!mainLine || this.layoutTokens.length === 0) return;
		const width = this.getMainContentWidth(mainLine);
		if (width <= 0) return;
		if (Math.abs(width - this.lastMainWidth) > 0.5) {
			this.applyManualLineBreaks(mainLine);
		}
	}

	private measureNodeWidth(node: Node, transformScale = 1): number {
		const scale = transformScale > 0 ? transformScale : 1;
		if (node instanceof HTMLElement) {
			const rectWidth = node.getBoundingClientRect().width;
			const visualPadding = this.getNodeHorizontalPadding(node) * scale;
			const visualWidth = rectWidth - visualPadding;
			return Math.max(0, visualWidth / scale);
		}
		if (node instanceof Text) {
			const range = document.createRange();
			range.selectNodeContents(node);
			return range.getBoundingClientRect().width / scale;
		}
		return 0;
	}

	private chooseBalancedBreakIndex(
		start: number,
		end: number,
		targetWidth: number,
		prefixWidths: number[],
		maxWidth: number,
		remainingLines: number,
	): number {
		const lineWidthOf = (j: number) =>
			prefixWidths[j + 1] - prefixWidths[start];
		const noOverflow = (j: number) => lineWidthOf(j) <= maxWidth;

		// 检查 breakAt 之后的内容能否在 remainingLines-1 行内放下
		const remainderCanFit = (breakAt: number): boolean => {
			const remLines = remainingLines - 1;
			if (remLines <= 0) return true;
			let lines = 1;
			let w = 0;
			for (let i = breakAt + 1; i < this.layoutTokens.length; i++) {
				const tw = this.layoutTokens[i].width;
				if (w + tw > maxWidth && w > 0) {
					lines++;
					w = tw;
				} else {
					w += tw;
				}
			}
			return lines <= remLines;
		};

		const isValid = (j: number) => noOverflow(j) && remainderCanFit(j);

		const preferred: number[] = [];
		const segmented: number[] = [];
		for (let j = start; j <= end; j++) {
			if (this.layoutTokens[j].breakPriority >= 2) {
				preferred.push(j);
			}
			if (this.isWordBoundaryBreakIndex(j)) {
				segmented.push(j);
			}
		}

		const pick = (candidates: number[]) => {
			let best = candidates[0];
			let bestScore = Number.POSITIVE_INFINITY;
			for (const j of candidates) {
				const width = lineWidthOf(j);
				const score = Math.abs(width - targetWidth);
				if (score < bestScore) {
					best = j;
					bestScore = score;
				}
			}
			return best;
		};

		const preferredSafe = preferred.filter(isValid);
		if (preferredSafe.length > 0) {
			return pick(preferredSafe);
		}

		const segmentedSafe = segmented.filter(isValid);
		if (segmentedSafe.length > 0) {
			return pick(segmentedSafe);
		}

		// 所有优先候选点都无法让余下内容收纳进剩余行，直接 balanced 分配（仅保证当前行不溢出）
		const allSafe: number[] = [];
		for (let j = start; j <= end; j++) {
			if (noOverflow(j)) allSafe.push(j);
		}
		if (allSafe.length > 0) return pick(allSafe);

		// 连不溢出的断点都没有（单个 token 超宽），只能取 end
		return end;
	}

	private clearManualLineBreaks(main: HTMLDivElement) {
		for (const line of this.manualLineContainers) {
			while (line.firstChild) {
				line.parentNode?.insertBefore(line.firstChild, line);
			}
			line.remove();
		}
		this.manualLineContainers = [];
		main.classList.remove(styles.manualLineBreakEnabled);
	}

	private applyManualLineBreaks(main: HTMLDivElement) {
		this.clearManualLineBreaks(main);
		if (!this.lyricPlayer.getManualLineBreakConfig().enabled) {
			return;
		}
		if (this.layoutTokens.length === 0) {
			return;
		}

		const maxWidth = this.getMainContentWidth(main);
		const transformScale = this.getMainTransformScale(main);
		if (maxWidth <= 0) {
			return;
		}

		main.classList.add(styles.manualLineBreakEnabled);

		for (const token of this.layoutTokens) {
			token.width = this.measureNodeWidth(token.node, transformScale);
		}

		const totalWidth = this.layoutTokens.reduce((sum, t) => sum + t.width, 0);

		if (totalWidth <= maxWidth) {
			this.lastMainWidth = maxWidth;
			return;
		}

		// 最少需要几行
		let desiredLines = 1;
		let greedyWidth = 0;
		for (const token of this.layoutTokens) {
			if (greedyWidth + token.width > maxWidth && greedyWidth > 0) {
				desiredLines++;
				greedyWidth = token.width;
			} else {
				greedyWidth += token.width;
			}
		}

		if (desiredLines <= 1) {
			this.lastMainWidth = maxWidth;
			return;
		}

		// 前缀宽度和
		const prefixWidths: number[] = [0];
		for (const token of this.layoutTokens) {
			prefixWidths.push(prefixWidths[prefixWidths.length - 1] + token.width);
		}

		const lineRanges: Array<[number, number]> = [];
		let lineStart = 0;
		const breakCount = desiredLines - 1;

		for (let lineIndex = 0; lineIndex < breakCount; lineIndex++) {
			const remainingBreaks = breakCount - lineIndex;
			const endLimit = this.layoutTokens.length - remainingBreaks - 1;
			const remainingWidth = totalWidth - prefixWidths[lineStart];
			const remainingLines = desiredLines - lineIndex;
			const targetWidth = remainingWidth / remainingLines;

			// 当前行最多能放到哪一个 token 而不溢出
			let rightMostFit = lineStart;
			for (let j = lineStart; j <= endLimit; j++) {
				const width = prefixWidths[j + 1] - prefixWidths[lineStart];
				if (width <= maxWidth) {
					rightMostFit = j;
				} else {
					break;
				}
			}

			const breakIndex = this.chooseBalancedBreakIndex(
				lineStart,
				rightMostFit,
				targetWidth,
				prefixWidths,
				maxWidth,
				remainingLines,
			);

			lineRanges.push([lineStart, breakIndex]);
			lineStart = breakIndex + 1;
		}

		if (lineStart <= this.layoutTokens.length - 1) {
			lineRanges.push([lineStart, this.layoutTokens.length - 1]);
		}

		const fragment = document.createDocumentFragment();
		for (const [start, end] of lineRanges) {
			const line = document.createElement("div");
			line.classList.add(styles.lyricManualLine);
			for (let i = start; i <= end; i++) {
				line.appendChild(this.layoutTokens[i].node);
			}
			this.manualLineContainers.push(line);
			fragment.appendChild(line);
		}
		main.appendChild(fragment);
		this.lastMainWidth = maxWidth;
	}

	private getRubyCharCount(word: LyricWord) {
		return (word.ruby ?? []).reduce(
			(total, ruby) => total + ruby.word.length,
			0,
		);
	}

	private getRubySegments(word: LyricWord) {
		return (word.ruby ?? []).filter(
			(ruby) => (ruby?.word?.trim().length ?? 0) > 0,
		);
	}

	private createWord(
		word: LyricWord,
		shouldEmphasize: boolean,
		hasRubyLine: boolean,
		hasRomanLine: boolean,
	): RealWord {
		const mainWordEl = document.createElement("span");
		const subElements: HTMLSpanElement[] = [];
		const romanWord = word.romanWord?.trim() ?? "";
		const wordContainer = hasRubyLine
			? document.createElement("div")
			: mainWordEl;

		if (hasRubyLine) {
			const rubyWordEl = document.createElement("div");
			const rubySegments = this.getRubySegments(word);
			for (const ruby of rubySegments) {
				const rubyPartEl = document.createElement("span");
				rubyPartEl.innerText = ruby.word;
				rubyPartEl.dataset.startTime = String(ruby.startTime);
				rubyPartEl.dataset.endTime = String(ruby.endTime);
				rubyWordEl.appendChild(rubyPartEl);
			}
			rubyWordEl.classList.add(styles.rubyWord);
			mainWordEl.classList.add(styles.wordWithRuby);
			wordContainer.classList.add(styles.wordBody);
			mainWordEl.appendChild(rubyWordEl);
			mainWordEl.appendChild(wordContainer);
		}

		const displayWord = this.lyricPlayer.processObsceneWord(word);

		if (shouldEmphasize) {
			mainWordEl.classList.add(styles.emphasize);
			for (const { segment } of this.segmenter.segment(displayWord.trim())) {
				const charEl = document.createElement("span");
				charEl.innerText = segment;
				subElements.push(charEl);
				wordContainer.appendChild(charEl);
			}
		} else {
			if (hasRomanLine) {
				const wordEl = document.createElement("div");
				wordEl.innerText = displayWord.trim();
				wordContainer.appendChild(wordEl);
			} else if (romanWord.length === 0) {
				wordContainer.innerText = displayWord.trim();
			}
		}

		if (hasRomanLine) {
			const romanWordEl = document.createElement("div");
			romanWordEl.innerText = romanWord.length > 0 ? romanWord : "\u00A0";
			romanWordEl.classList.add(styles.romanWord);
			wordContainer.appendChild(romanWordEl);
		}

		const realWord: RealWord = {
			...word,
			mainElement: mainWordEl,
			subElements: subElements,
			elementAnimations: [this.initFloatAnimation(word, mainWordEl)],
			maskAnimations: [],
			width: 0,
			height: 0,
			padding: 0,
			shouldEmphasize: shouldEmphasize,
		};

		return realWord;
	}

	private buildWord(
		input: LyricWord | LyricWord[],
		main: HTMLDivElement,
		hasRubyLine: boolean,
		hasRomanLine: boolean,
	) {
		const chunk = Array.isArray(input) ? input : [input];
		if (chunk.length === 0) return;

		const isPureSpace = chunk.every((w) => !w.word.trim());
		if (isPureSpace) {
			const textContent = chunk.map((w) => w.word).join("");
			const textNode = document.createTextNode(textContent);
			main.appendChild(textNode);
			this.pushLayoutToken(textNode, textContent);
			return;
		}

		const merged = chunk.reduce(
			(a, b) => {
				a.endTime = Math.max(a.endTime, b.endTime);
				a.startTime = Math.min(a.startTime, b.startTime);
				a.word += b.word;
				return a;
			},
			{
				word: "",
				romanWord: "",
				startTime: Number.POSITIVE_INFINITY,
				endTime: Number.NEGATIVE_INFINITY,
				wordType: "normal",
				obscene: false,
			} as LyricWord,
		);

		let emp = chunk.some((word) => LyricLineBase.shouldEmphasize(word));
		if (!isCJK(merged.word)) {
			emp = emp || LyricLineBase.shouldEmphasize(merged);
		}

		const wrapperWordEl = document.createElement("span");
		wrapperWordEl.classList.add(styles.emphasizeWrapper);

		const characterElements: HTMLElement[] = [];

		for (const word of chunk) {
			if (!word.word.trim()) {
				wrapperWordEl.appendChild(document.createTextNode(word.word));
				continue;
			}

			const realWord = this.createWord(word, emp, hasRubyLine, hasRomanLine);

			if (emp) {
				characterElements.push(...realWord.subElements);
			}

			this.splittedWords.push(realWord);
			wrapperWordEl.appendChild(realWord.mainElement);
		}

		if (emp && this.splittedWords.length > 0) {
			const lastWordOfChunk = this.splittedWords[this.splittedWords.length - 1];
			const rubyCharCount = chunk.reduce(
				(total, word) => total + this.getRubyCharCount(word),
				0,
			);

			lastWordOfChunk.elementAnimations.push(
				...this.initEmphasizeAnimation(
					merged,
					characterElements,
					merged.endTime - merged.startTime,
					merged.startTime - this.lyricLine.startTime,
					rubyCharCount,
				),
			);
		}

		main.appendChild(wrapperWordEl);
		this.pushLayoutToken(wrapperWordEl, merged.word);
	}

	private initFloatAnimation(word: LyricWord, wordEl: HTMLSpanElement) {
		const delay = word.startTime - this.lyricLine.startTime;
		const duration = Math.max(1000, word.endTime - word.startTime);
		let up = 0.05;
		if (this.lyricLine.isBG) {
			up *= 2;
		}
		const a = wordEl.animate(
			[
				{
					transform: "translateY(0px)",
				},
				{
					transform: `translateY(${-up}em)`,
				},
			],
			{
				duration: Number.isFinite(duration) ? duration : 0,
				delay: Number.isFinite(delay) ? delay : 0,
				id: "float-word",
				composite: "add",
				fill: "both",
				easing: "ease-out",
			},
		);
		a.pause();
		return a;
	}
	// 按照原 Apple Music 参考，强调效果只应用缩放、轻微左右位移和辉光效果，原主要的悬浮位移效果不变
	// 为了避免产生锯齿抖动感，使用 matrix3d 来实现缩放和位移
	private initEmphasizeAnimation(
		word: LyricWord,
		characterElements: HTMLElement[],
		duration: number,
		delay: number,
		rubyCharCount: number,
	): Animation[] {
		const de = Math.max(0, delay);
		let du = Math.max(1000, duration);
		const anchorCharCount =
			rubyCharCount > 0 ? rubyCharCount : Math.max(1, characterElements.length);

		let result: Animation[] = [];

		let amount = du / 2000;
		amount = amount > 1 ? Math.sqrt(amount) : amount ** 3;
		let blur = du / 3000;
		blur = blur > 1 ? Math.sqrt(blur) : blur ** 3;
		amount *= 0.6;
		blur *= 0.5;
		if (
			this.lyricLine.words.length > 0 &&
			word.word.includes(
				this.lyricLine.words[this.lyricLine.words.length - 1].word,
			)
		) {
			amount *= 1.6;
			blur *= 1.5;
			du *= 1.2;
		}
		amount = Math.min(1.2, amount);
		blur = Math.min(0.8, blur);

		const animateDu = Number.isFinite(du) ? du : 0;
		const empEasing = makeEmpEasing(EMP_EASING_MID);

		result = characterElements.flatMap((el, i, arr) => {
			const wordDe = de + (du / 2.5 / anchorCharCount) * i;
			const result: Animation[] = [];

			const frames: Keyframe[] = new Array(ANIMATION_FRAME_QUANTITY)
				.fill(0)
				.map((_, j) => {
					const x = (j + 1) / ANIMATION_FRAME_QUANTITY;
					const transX = empEasing(x);
					const glowLevel = empEasing(x) * blur;

					const mat = scaleMatrix4(createMatrix4(), 1 + transX * 0.1 * amount);
					const offsetX = -transX * 0.03 * amount * (arr.length / 2 - i);
					const offsetY = -transX * 0.025 * amount;

					return {
						offset: x,
						transform: `${matrix4ToCSS(
							mat,
							4,
						)} translate(${offsetX}em, ${offsetY}em)`,
						textShadow: `0 0 ${Math.min(
							0.3,
							blur * 0.3,
						)}em rgba(255, 255, 255, ${glowLevel})`,
					};
				});

			const glow = el.animate(frames, {
				duration: animateDu,
				delay: Number.isFinite(wordDe) ? wordDe : 0,
				id: `emphasize-word-${el.innerText}-${i}`,
				iterations: 1,
				composite: "replace",
				fill: "both",
			});
			glow.onfinish = () => {
				glow.pause();
			};
			glow.pause();
			result.push(glow);

			const floatFrame: Keyframe[] = new Array(ANIMATION_FRAME_QUANTITY)
				.fill(0)
				.map((_, j) => {
					const x = (j + 1) / ANIMATION_FRAME_QUANTITY;
					let y = Math.sin(x * Math.PI);
					// y = x < 0.5 ? y : Math.max(y, 1.0);
					if (this.lyricLine.isBG) {
						y *= 2;
					}

					return {
						offset: x,
						transform: `translateY(${-y * 0.05}em)`,
					};
				});
			const float = el.animate(floatFrame, {
				duration: animateDu * 1.4,
				delay: Number.isFinite(wordDe) ? wordDe - 400 : 0,
				id: "emphasize-word-float",
				iterations: 1,
				composite: "add",
				fill: "both",
			});
			float.onfinish = () => {
				float.pause();
			};
			float.pause();
			result.push(float);

			return result;
		});

		return result;
	}

	private get totalDuration() {
		return this.lyricLine.endTime - this.lyricLine.startTime;
	}

	override onLineSizeChange(_size: [number, number]): void {
		const main = this.element.children[0] as HTMLDivElement;
		if (main) this.maybeReflowManualLineBreak(main);
		this.updateMaskImageSync();
	}
	updateMaskImageSync(): void {
		for (const word of this.splittedWords) {
			const el = word.mainElement;
			if (el) {
				word.padding = Number.parseFloat(getComputedStyle(el).paddingLeft);
				word.width = el.clientWidth - word.padding * 2;
				word.height = el.clientHeight - word.padding * 2;
			} else {
				word.width = 0;
				word.height = 0;
				word.padding = 0;
			}
		}
		if (this.lyricPlayer.supportMaskImage) {
			this.generateWebAnimationBasedMaskImage();
		} else {
			this.generateCalcBasedMaskImage();
		}
		if (this.isEnabled) {
			const isPlayerRunning = this.lyricPlayer.getIsPlaying?.() ?? true;
			this.enable(this.lyricPlayer.getCurrentTime(), isPlayerRunning);
		}
	}

	private generateCalcBasedMaskImage() {
		for (const word of this.splittedWords) {
			const wordEl = word.mainElement;
			if (wordEl) {
				word.width = wordEl.clientWidth;
				word.height = wordEl.clientHeight;
				const fadeWidth = word.height * this.lyricPlayer.getWordFadeWidth();
				const [maskImage, totalAspect] = generateFadeGradient(
					fadeWidth / word.width,
				);
				const totalAspectStr = `${totalAspect * 100}% 100%`;
				if (this.lyricPlayer.supportMaskImage) {
					wordEl.style.maskImage = maskImage;
					wordEl.style.maskRepeat = "no-repeat";
					wordEl.style.maskOrigin = "left";
					wordEl.style.maskSize = totalAspectStr;
				} else {
					wordEl.style.webkitMaskImage = maskImage;
					wordEl.style.webkitMaskRepeat = "no-repeat";
					wordEl.style.webkitMaskOrigin = "left";
					wordEl.style.webkitMaskSize = totalAspectStr;
				}
				const w = word.width + fadeWidth;
				const maskPos = `clamp(${-w}px,calc(${-w}px + (var(--amll-player-time) - ${
					word.startTime
				})*${
					w / Math.abs(word.endTime - word.startTime)
				}px),0px) 0px, left top`;
				wordEl.style.maskPosition = maskPos;
				wordEl.style.webkitMaskPosition = maskPos;
			}
		}
	}

	private generateWebAnimationBasedMaskImage() {
		// 因为歌词行有可能比行内单词的结束时间早，有可能导致过渡动画提早停止出现瑕疵
		// 所以要以单词的结束时间为准
		const totalFadeDuration =
			Math.max(
				this.splittedWords.reduce((pv, w) => Math.max(w.endTime, pv), 0),
				this.lyricLine.endTime,
			) - this.lyricLine.startTime;
		this.splittedWords.forEach((word, i) => {
			const wordEl = word.mainElement;
			if (wordEl) {
				const fadeWidth = word.height * this.lyricPlayer.getWordFadeWidth();
				const [maskImage, totalAspect] = generateFadeGradient(
					fadeWidth / (word.width + word.padding * 2),
				);
				const totalAspectStr = `${totalAspect * 100}% 100%`;
				if (this.lyricPlayer.supportMaskImage) {
					wordEl.style.maskImage = maskImage;
					wordEl.style.maskRepeat = "no-repeat";
					wordEl.style.maskOrigin = "left";
					wordEl.style.maskSize = totalAspectStr;
				} else {
					wordEl.style.webkitMaskImage = maskImage;
					wordEl.style.webkitMaskRepeat = "no-repeat";
					wordEl.style.webkitMaskOrigin = "left";
					wordEl.style.webkitMaskSize = totalAspectStr;
				}
				// 为了尽可能将渐变动画在相连的每个单词间近似衔接起来
				// 要综合每个单词的效果时间和间隙生成动画帧数组
				const widthBeforeSelf =
					this.splittedWords.slice(0, i).reduce((a, b) => a + b.width, 0) +
					(this.splittedWords[0] ? fadeWidth : 0);
				const minOffset = -(word.width + word.padding * 2 + fadeWidth);
				const clampOffset = (x: number) => Math.max(minOffset, Math.min(0, x));
				let curPos = -widthBeforeSelf - word.width - word.padding - fadeWidth;
				let timeOffset = 0;
				const frames: Keyframe[] = [];
				let lastPos = curPos;
				let lastTime = 0;
				const pushFrame = () => {
					// 此处如果添加过渡函数，会导致单词时序不准确，所以不添加
					// const easing = "cubic-bezier(.33,.12,.83,.9)";
					const moveOffset = curPos - lastPos;
					const time = Math.max(0, Math.min(1, timeOffset));
					const duration = time - lastTime;
					const d = Math.abs(duration / moveOffset);
					// 因为有可能会和之前的动画有边界
					if (curPos > minOffset && lastPos < minOffset) {
						const staticTime = Math.abs(lastPos - minOffset) * d;
						const value = `${clampOffset(lastPos)}px 0`;
						const frame: Keyframe = {
							offset: lastTime + staticTime,
							maskPosition: value,
						};
						frames.push(frame);
					}
					if (curPos > 0 && lastPos < 0) {
						const staticTime = Math.abs(lastPos) * d;
						const value = `${clampOffset(curPos)}px 0`;
						const frame: Keyframe = {
							offset: lastTime + staticTime,
							maskPosition: value,
						};
						frames.push(frame);
					}
					const value = `${clampOffset(curPos)}px 0`;
					const frame: Keyframe = {
						offset: time,
						maskPosition: value,
					};
					frames.push(frame);
					lastPos = curPos;
					lastTime = time;
				};
				pushFrame();
				let lastTimeStamp = 0;
				this.splittedWords.forEach((otherWord, j) => {
					// 停顿
					{
						const curTimeStamp = otherWord.startTime - this.lyricLine.startTime;
						const staticDuration = curTimeStamp - lastTimeStamp;
						timeOffset += staticDuration / totalFadeDuration;
						if (staticDuration > 0) pushFrame();
						lastTimeStamp = curTimeStamp;
					}
					// 移动
					{
						const fadeDuration = Math.max(
							0,
							otherWord.endTime - otherWord.startTime,
						);
						const rubySegments = this.getRubySegments(otherWord);
						const rubyCharCount = rubySegments.reduce(
							(total, ruby) => total + ruby.word.length,
							0,
						);
						if (rubyCharCount > 0) {
							const widthPerChar = otherWord.width / rubyCharCount;
							let charIndex = 0;
							for (const ruby of rubySegments) {
								const rubyStartTime = Number.isFinite(ruby.startTime)
									? ruby.startTime
									: otherWord.startTime;
								const rubyEndTime = Number.isFinite(ruby.endTime)
									? ruby.endTime
									: otherWord.endTime;
								const rubyStart = Math.max(rubyStartTime, otherWord.startTime);
								const rubyEnd = Math.min(
									Math.max(rubyEndTime, rubyStart),
									otherWord.endTime,
								);
								const rubyStartStamp = rubyStart - this.lyricLine.startTime;
								const rubyStaticDuration = rubyStartStamp - lastTimeStamp;
								timeOffset += rubyStaticDuration / totalFadeDuration;
								if (rubyStaticDuration > 0) pushFrame();
								lastTimeStamp = rubyStartStamp;
								const rubyDuration = Math.max(0, rubyEnd - rubyStart);
								const perCharDuration = rubyDuration / ruby.word.length;
								for (
									let rubyCharIndex = 0;
									rubyCharIndex < ruby.word.length;
									rubyCharIndex++
								) {
									timeOffset += perCharDuration / totalFadeDuration;
									curPos += widthPerChar;
									if (j === 0 && charIndex === 0) {
										curPos += fadeWidth * 1.5;
									}
									if (
										j === this.splittedWords.length - 1 &&
										charIndex === rubyCharCount - 1
									) {
										curPos += fadeWidth * 0.5;
									}
									if (perCharDuration > 0) pushFrame();
									lastTimeStamp += perCharDuration;
									charIndex++;
								}
							}
							const wordEndStamp = Math.max(
								otherWord.endTime - this.lyricLine.startTime,
								lastTimeStamp,
							);
							const wordTailDuration = wordEndStamp - lastTimeStamp;
							timeOffset += wordTailDuration / totalFadeDuration;
							if (wordTailDuration > 0) pushFrame();
							lastTimeStamp = wordEndStamp;
						} else {
							const segmentCount = 1;
							const segmentWidth = otherWord.width / segmentCount;
							const segmentDuration = fadeDuration / segmentCount;
							for (
								let segmentIndex = 0;
								segmentIndex < segmentCount;
								segmentIndex++
							) {
								timeOffset += segmentDuration / totalFadeDuration;
								curPos += segmentWidth;
								if (j === 0 && segmentIndex === 0) {
									curPos += fadeWidth * 1.5;
								}
								if (
									j === this.splittedWords.length - 1 &&
									segmentIndex === segmentCount - 1
								) {
									curPos += fadeWidth * 0.5;
								}
								if (segmentDuration > 0) pushFrame();
								lastTimeStamp += segmentDuration;
							}
						}
					}
				});
				for (const a of word.maskAnimations) {
					a.cancel();
				}
				try {
					// TODO: 如果此处动画帧计算出错，需要一个后备方案
					// 此处如果添加过渡函数，会导致单词时序不准确，所以不添加
					const ani = wordEl.animate(frames, {
						duration: totalFadeDuration || 1,
						id: `fade-word-${word.word}-${i}`,
						fill: "both",
					});
					ani.pause();
					word.maskAnimations = [ani];
				} catch (err) {
					console.warn("应用渐变动画发生错误", frames, totalFadeDuration, err);
				}
			}
		});
	}
	getElement(): HTMLElement {
		return this.element;
	}

	private updateMaskAlphaTargets(scale: number) {
		const factor = Math.max(0.0, Math.min(1.0, (scale - 0.97) / 0.03));
		const dynamicDarkAlpha = factor * 0.2 + 0.2;
		const dynamicBrightAlpha = factor * 0.8 + 0.2;

		if (this.renderMode === LyricLineRenderMode.SOLID) {
			this.targetBrightAlpha = dynamicDarkAlpha;
			this.targetDarkAlpha = dynamicDarkAlpha;
		} else {
			this.targetBrightAlpha = dynamicBrightAlpha;
			this.targetDarkAlpha = dynamicDarkAlpha;
		}
	}

	private applyAlphaToDom(delta: number) {
		const dt = delta || 0.016;
		const ATTACK_SPEED = 50.0;
		const RELEASE_SPEED = 7.0;
		const getFactor = (speed: number) => 1 - Math.exp(-speed * dt);

		// 根据即将变亮还是变暗选择速度
		// 如果即将变亮，让速度非常快，以免播放到第一个字的时候透明度还在慢慢增加导致看不清
		const isBrightening = this.targetBrightAlpha > this.currentBrightAlpha;
		const brightSpeed = isBrightening ? ATTACK_SPEED : RELEASE_SPEED;
		const brightFactor = getFactor(brightSpeed);

		if (Math.abs(this.targetBrightAlpha - this.currentBrightAlpha) < 0.001) {
			this.currentBrightAlpha = this.targetBrightAlpha;
		} else {
			this.currentBrightAlpha +=
				(this.targetBrightAlpha - this.currentBrightAlpha) * brightFactor;
		}

		const isDarkening = this.targetDarkAlpha > this.currentDarkAlpha;
		const darkSpeed = isDarkening ? ATTACK_SPEED : RELEASE_SPEED;
		const darkFactor = getFactor(darkSpeed);

		if (Math.abs(this.targetDarkAlpha - this.currentDarkAlpha) < 0.001) {
			this.currentDarkAlpha = this.targetDarkAlpha;
		} else {
			this.currentDarkAlpha +=
				(this.targetDarkAlpha - this.currentDarkAlpha) * darkFactor;
		}

		this.element.style.setProperty(
			"--bright-mask-alpha",
			this.currentBrightAlpha.toFixed(3),
		);
		this.element.style.setProperty(
			"--dark-mask-alpha",
			this.currentDarkAlpha.toFixed(3),
		);
	}

	override setTransform(
		top: number = this.top,
		scale: number = this.scale,
		opacity = 1,
		blur = 0,
		force = false,
		delay = 0,
		mode: LyricLineRenderMode = LyricLineRenderMode.SOLID,
	): void {
		super.setTransform(top, scale, opacity, blur, force, delay);
		this.renderMode = mode;
		const beforeInSight = this.isInSight;
		const enableSpring = this.lyricPlayer.getEnableSpring();
		this.top = top;
		this.scale = scale;
		this.delay = (delay * 1000) | 0;
		const main = this.element.children[0] as HTMLDivElement;
		// main.style.opacity = `${opacity *
		// 	(!this.hasFaded ? 1 : this.lyricPlayer._getIsNonDynamic() ? 1 : 0.3)
		// 	}`;
		main.style.opacity = `${opacity}`;
		if (force || !enableSpring) {
			this.blur = Math.min(32, blur);
			// if (force) this.element.classList.add(styles.tmpDisableTransition);
			// this.lineWebAnimationTransforms.posX.setTargetPosition(left);
			// this.lineWebAnimationTransforms.posY.setTargetPosition(top);
			// this.lineWebAnimationTransforms.scale.setTargetPosition(scale);
			this.lineTransforms.posY.setPosition(top);
			this.lineTransforms.scale.setPosition(scale);
			if (!enableSpring) {
				const afterInSight = this.isInSight;
				if (beforeInSight || afterInSight) {
					this.show();
				} else {
					this.hide();
				}
			} else this.rebuildStyle();
			// if (force)
			// 	requestAnimationFrame(() => {
			// 		this.element.classList.remove(styles.tmpDisableTransition);
			// 	});
			const currentScale = this.lineTransforms.scale.getCurrentPosition();
			this.updateMaskAlphaTargets(currentScale / 100);
			this.currentBrightAlpha = this.targetBrightAlpha;
			this.currentDarkAlpha = this.targetDarkAlpha;
			this.element.style.setProperty(
				"--bright-mask-alpha",
				String(this.currentBrightAlpha),
			);
			this.element.style.setProperty(
				"--dark-mask-alpha",
				String(this.currentDarkAlpha),
			);
		} else {
			// this.lineWebAnimationTransforms.posX.stop();
			// this.lineWebAnimationTransforms.posY.stop();
			// this.lineWebAnimationTransforms.scale.stop();
			this.lineTransforms.posY.setTargetPosition(top, delay);
			this.lineTransforms.scale.setTargetPosition(scale);
			if (this.blur !== Math.min(5, blur)) {
				this.blur = Math.min(5, blur);
				const roundedBlur = blur.toFixed(3);
				this.element.style.filter = `blur(${roundedBlur}px)`;
			}
		}
	}

	update(delta = 0): void {
		if (!this.lyricPlayer.getEnableSpring()) return;

		this.lineTransforms.posY.update(delta);
		this.lineTransforms.scale.update(delta);

		if (this.isInSight) {
			this.show();
		} else {
			this.hide();
		}

		const currentScale = this.lineTransforms.scale.getCurrentPosition() / 100;
		this.updateMaskAlphaTargets(currentScale);
		this.applyAlphaToDom(delta);
	}

	_getDebugTargetPos(): string {
		return `[位移: ${this.top}; 缩放: ${this.scale}; 延时: ${this.delay}]`;
	}

	get isInSight(): boolean {
		const t = this.lineTransforms.posY.getCurrentPosition();
		const h = this.lyricPlayer.lyricLinesSize.get(this)?.[1] ?? 0;
		const b = t + h;
		const pb = this.lyricPlayer.size[1];
		const ov = this.lyricPlayer.getOverscanPx();
		return !(t > pb + h + ov || b < -h - ov);
	}
	private disposeElements() {
		this.layoutTokens = [];
		this.lastMainWidth = 0;
		for (const realWord of this.splittedWords) {
			for (const a of realWord.elementAnimations) {
				a.cancel();
			}
			for (const a of realWord.maskAnimations) {
				a.cancel();
			}
			for (const sub of realWord.subElements) {
				sub.remove();
				sub.parentNode?.removeChild(sub);
			}
			realWord.elementAnimations = [];
			realWord.maskAnimations = [];
			realWord.subElements = [];
			if (realWord.mainElement?.parentNode) {
				realWord.mainElement.parentNode.removeChild(realWord.mainElement);
			}
		}
		this.splittedWords = [];
		const main = this.element.children[0] as HTMLDivElement;
		const trans = this.element.children[1] as HTMLDivElement;
		const roman = this.element.children[2] as HTMLDivElement;
		if (main) {
			this.clearManualLineBreaks(main);
			main.innerHTML = "";
		}
		if (trans) trans.innerHTML = "";
		if (roman) roman.innerHTML = "";
	}
	override dispose(): void {
		this.disposeElements();
		this.lyricPlayer.resizeObserver.unobserve(this.element);
		this.element.remove();
	}
}
