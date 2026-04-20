/**
 * @fileoverview
 * 一个播放歌词的组件
 * @author SteveXMH
 */

import type { LyricLine } from "../../interfaces.ts";
import "../../styles/index.css";
import styles from "../../styles/lyric-player.module.css";
import { type LyricLineBase, LyricPlayerBase } from "../base.ts";
import { LyricLineEl, type RawLyricLineMouseEvent } from "./lyric-line.ts";

/**
 * 歌词行鼠标相关事件，可以获取到歌词行的索引和歌词行元素
 */
export class LyricLineMouseEvent extends MouseEvent {
	constructor(
		/**
		 * 歌词行索引
		 */
		public readonly lineIndex: number,
		/**
		 * 歌词行元素
		 */
		public readonly line: LyricLineBase,
		event: MouseEvent,
	) {
		super(`line-${event.type}`, event);
	}
}

export type LyricLineMouseEventListener = (evt: LyricLineMouseEvent) => void;

export interface LyricManualLineBreakConfig {
	/** 是否启用手动断行，默认启用 */
	enabled: boolean;
	/** 允许作为优先断行点的标点集合（在这些字符后优先换行） */
	punctuations: string;
}

const DEFAULT_MANUAL_LINE_BREAK_CONFIG: LyricManualLineBreakConfig = {
	enabled: true,
	punctuations: ",.;:!?，。；：！？、）】》」』’”)]}>~，。！？；：、…",
};

/**
 * 歌词播放组件，本框架的核心组件
 *
 * 尽可能贴切 Apple Music for iPad 的歌词效果设计，且做了力所能及的优化措施
 */
export class DomLyricPlayer extends LyricPlayerBase {
	override currentLyricLineObjects: LyricLineEl[] = [];
	private manualLineBreakConfig: LyricManualLineBreakConfig = {
		...DEFAULT_MANUAL_LINE_BREAK_CONFIG,
	};

	override onResize(): void {
		const computedStyles = getComputedStyle(this.element);
		this._baseFontSize = Number.parseFloat(computedStyles.fontSize);
		this.rebuildStyle();
	}

	readonly supportPlusLighter: boolean = CSS.supports(
		"mix-blend-mode",
		"plus-lighter",
	);
	readonly supportMaskImage: boolean = CSS.supports("mask-image", "none");
	readonly innerSize: [number, number] = [0, 0];
	private readonly onLineClickedHandler = (e: RawLyricLineMouseEvent) => {
		const evt = new LyricLineMouseEvent(
			this.lyricLinesIndexes.get(e.line) ?? -1,
			e.line,
			e,
		);
		if (!this.dispatchEvent(evt)) {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
		}
	};
	/**
	 * 是否为非逐词歌词
	 * @internal
	 */
	_getIsNonDynamic(): boolean {
		return this.isNonDynamic;
	}
	private _baseFontSize = Number.parseFloat(
		getComputedStyle(this.element).fontSize,
	);
	public get baseFontSize(): number {
		return this._baseFontSize;
	}
	constructor() {
		super();
		this.onResize();
		this.element.classList.add("amll-lyric-player", "dom");
		if (this.disableSpring) {
			this.element.classList.add(styles.disableSpring);
		}
	}

	private rebuildStyle() {
		// const width = this.innerSize[0];
		// const height = this.innerSize[1];
		// this.element.style.setProperty("--amll-lp-width", `${width.toFixed(4)}px`);
		// this.element.style.setProperty(
		// 	"--amll-lp-height",
		// 	`${height.toFixed(4)}px`,
		// );
	}

	/**
	 * 设置手动断行配置（仅对 DomLyricPlayer 生效）
	 *
	 * - `enabled=true` 时，歌词主行将使用内部排版算法断行，不依赖浏览器自动换行
	 * - 优先在空格以及 `punctuations` 中指定的字符后断行
	 */
	setManualLineBreakConfig(options: Partial<LyricManualLineBreakConfig>): void {
		const next: LyricManualLineBreakConfig = {
			...this.manualLineBreakConfig,
			...options,
		};
		if (
			next.enabled === this.manualLineBreakConfig.enabled &&
			next.punctuations === this.manualLineBreakConfig.punctuations
		) {
			return;
		}
		this.manualLineBreakConfig = next;
		this.rebuildLyricLines();
		this.calcLayout(true);
	}

	getManualLineBreakConfig(): LyricManualLineBreakConfig {
		return { ...this.manualLineBreakConfig };
	}

	override setWordFadeWidth(value = 0.5): void {
		super.setWordFadeWidth(value);
		for (const el of this.currentLyricLineObjects) {
			el.updateMaskImageSync();
		}
	}

	/**
	 * 设置当前播放歌词，要注意传入后这个数组内的信息不得修改，否则会发生错误
	 * @param lines 歌词数组
	 * @param initialTime 初始时间，默认为 0
	 */
	override setLyricLines(lines: LyricLine[], initialTime = 0): void {
		super.setLyricLines(lines, initialTime);
		if (this.hasDuetLine) {
			this.element.classList.add(styles.hasDuetLine);
		} else {
			this.element.classList.remove(styles.hasDuetLine);
		}
		if (!this.supportMaskImage) {
			this.element.style.setProperty("--amll-player-time", `${initialTime}`);
		}

		for (const line of this.currentLyricLineObjects) {
			line.removeMouseEventListener("click", this.onLineClickedHandler);
			line.removeMouseEventListener("contextmenu", this.onLineClickedHandler);
			line.dispose();
		}

		// 创建新的歌词行元素
		this.currentLyricLineObjects = this.processedLines.map((line, i) => {
			const lineEl = new LyricLineEl(this, line);
			lineEl.addMouseEventListener("click", this.onLineClickedHandler);
			lineEl.addMouseEventListener("contextmenu", this.onLineClickedHandler);
			// 不立即挂载到 DOM，进入视图（含 overscan）后在 LyricLineEl 内部挂载
			this.lyricLinesIndexes.set(lineEl, i);
			// 仍需建立元素到行对象的映射，供 ResizeObserver 使用
			this.lyricLineElementMap.set(lineEl.getElement(), lineEl);
			return lineEl;
		});

		this.setLinePosXSpringParams({});
		this.setLinePosYSpringParams({});
		this.setLineScaleSpringParams({});
		this.calcLayout(true);
		// 触发一次更新以便立即挂载在视区/overscan 内的行元素
		this.update(0);
	}

	override pause(): void {
		super.pause();
		this.element.classList.remove("playing");
		this.interludeDots.pause();
		for (const line of this.currentLyricLineObjects) {
			line.pause();
		}
	}

	override resume(): void {
		super.resume();
		this.element.classList.add("playing");
		this.interludeDots.resume();
		for (const line of this.currentLyricLineObjects) {
			line.resume();
		}
	}

	override update(delta = 0): void {
		if (!this.initialLayoutFinished) return;
		super.update(delta);
		if (!this.supportMaskImage) {
			this.element.style.setProperty(
				"--amll-player-time",
				`${this.currentTime}`,
			);
		}
		if (!this.isPageVisible) return;
		const deltaS = delta / 1000;
		for (const line of this.currentLyricLineObjects) {
			line.update(deltaS);
		}
	}

	override dispose(): void {
		super.dispose();
		this.element.remove();
		for (const el of this.currentLyricLineObjects) {
			el.dispose();
		}
		this.bottomLine.dispose();
		this.interludeDots.dispose();
	}
}
