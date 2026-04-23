import styles from "../../styles/lyric-player.module.css";
import { isCJK } from "../../utils/is-cjk.ts";
import type {LyricManualLineBreakConfig} from "./index.ts";

export interface LayoutToken {
	node: Node;
	breakPriority: number;
	width: number;
	text: string;
}

export class ManualLineBreaker {
	private layoutTokens: LayoutToken[] = [];
	private manualLineContainers: HTMLDivElement[] = [];
	private lastMainWidth = 0;

	constructor(private readonly getConfig: () => LyricManualLineBreakConfig) {}

	reset(): void {
		this.layoutTokens = [];
		this.lastMainWidth = 0;
	}

	pushToken(node: Node, rawText: string, breakPriority: number = -1): void {
		let priority = breakPriority;
		if (priority === -1) {
			if (rawText.trim().length === 0) {
				priority = 2;
			} else {
				const normalized = rawText.trimEnd();
				const lastChar = normalized.charAt(normalized.length - 1);
				if (lastChar && this.getConfig().punctuations.includes(lastChar)) {
					priority = 3;
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

	clear(main: HTMLDivElement): void {
		for (const line of this.manualLineContainers) {
			while (line.firstChild) {
				line.parentNode?.insertBefore(line.firstChild, line);
			}
			line.remove();
		}
		this.manualLineContainers = [];
		main.classList.remove(styles.manualLineBreakEnabled);
	}

	maybeReflow(main: HTMLDivElement): void {
		if (this.layoutTokens.length === 0) return;
		const width = this.getMainContentWidth(main);
		if (width <= 0) return;
		if (Math.abs(width - this.lastMainWidth) > 0.5) {
			this.apply(main);
		}
	}

	apply(main: HTMLDivElement): void {
		this.clear(main);
		if (!this.getConfig().enabled) {
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

		const punctuations = this.getConfig().punctuations;
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

		const allSafe: number[] = [];
		for (let j = start; j <= end; j++) {
			if (noOverflow(j)) allSafe.push(j);
		}
		if (allSafe.length > 0) return pick(allSafe);

		return end;
	}
}
