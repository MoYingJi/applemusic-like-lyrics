import styles from "../../styles/lyric-player.module.css";
import type { LyricManualLineBreakConfig } from "./index.ts";

/**
 * 断行布局单元，对应主行 DOM 中的一个连续节点片段。
 * 收集阶段 width 为 0，apply 时才测量并填入真实像素宽度。
 */
export interface LayoutToken {
	/** 对应的 DOM 节点（HTMLElement 或 Text） */
	node: Node;
	/**
	 * 断行优先级：
	 * - 0：不可/低优先级断行点
	 * - 2：空白符后（可断行）
	 * - 3：标点符号后（优先断行）
	 */
	breakPriority: number;
	/** 节点的视觉宽度（像素，apply 后填充） */
	width: number;
	/** 节点对应的原始文本，用于分词边界判断 */
	text: string;
}

/**
 * 手动断行管理器。
 *
 * 负责收集歌词主行的布局 token，并在宽度不足时将其按
 * "空格/标点优先、分词边界次之、均匀 balanced 兜底"的策略
 * 拆分到多个 `.lyricManualLine` 子容器中。
 *
 * 使用方式：
 * 1. 构建 DOM 时调用 {@link pushToken} 注册每个节点；
 * 2. DOM 插入布局后调用 {@link apply} 执行断行；
 * 3. 容器尺寸变化时调用 {@link maybeReflow} 按需重排；
 * 4. 重建元素前调用 {@link reset}（清空 token 列表）。
 */
export class ManualLineBreaker {
	/** 当前行所有布局 token，按 DOM 顺序排列 */
	private layoutTokens: LayoutToken[] = [];
	/** apply 生成的 `.lyricManualLine` 容器，用于 clear 时还原 DOM */
	private manualLineContainers: HTMLDivElement[] = [];
	/** 上次 apply 时的主行内容宽度，用于 maybeReflow 的变化检测 */
	private lastMainWidth = 0;
    /** 用于纯文本分段的分词器 */
    private segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

	constructor(private readonly getConfig: () => LyricManualLineBreakConfig) {}

	/** 重置 token 列表与缓存宽度，通常在重建元素前调用 */
	reset(): void {
		this.layoutTokens = [];
		this.lastMainWidth = 0;
	}

    /**
     * 将纯文本分段为 token 并追加到布局列表。
     */
    appendPlainTextTokens(main: HTMLDivElement, text: string): void {
        const punctuations = this.getConfig().punctuations;

        let currentToken = "";
        const flush = (token: string, isWhitespace: boolean = false) => {
            if (!token.length) return;
            const node = document.createTextNode(token);
            main.appendChild(node);
            if (isWhitespace) {
                this.pushToken(node, token, 3);
            } else {
                this.pushToken(node, token);
            }
        };

        for (const { segment } of this.segmenter.segment(text)) {
            // 空白字符单独成节点，权重 3，并结束当前正在累积的普通 token
            if (segment.trim().length === 0) {
                flush(currentToken, false);
                currentToken = "";
                flush(segment, true);
                continue;
            }

            // 非空白 segment
            if (punctuations.includes(segment)) {
                // 标点附着到前一个 token（如果存在），否则单独成 token
                if (currentToken.length) {
                    currentToken += segment;
                } else {
                    currentToken = segment;
                }
            } else {
                // 普通词：先提交之前的 token，再开始新 token
                flush(currentToken, false);
                currentToken = segment;
            }
        }
        flush(currentToken, false);
    }

	/**
	 * 向列表末尾追加一个布局 token。
	 * 若未显式指定 breakPriority，会根据文本内容自动推断：
	 * 纯空白 → 2，末字符为标点 → 3，其余 → 0。
	 */
	pushToken(node: Node, rawText: string, breakPriority: number = -1): void {
		let priority = breakPriority;
		if (priority === -1) {
			if (rawText.trim().length === 0) {
				priority = 2; // 空白
			} else {
				const normalized = rawText.trimEnd();
				const lastChar = normalized.charAt(normalized.length - 1);
				if (lastChar && this.getConfig().punctuations.includes(lastChar)) {
					priority = 3; // 标点符号
				} else {
                    priority = 0;
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

	/**
	 * 移除所有手动断行容器，将 token 节点还原到 main 直属子节点，
	 * 并移除 manualLineBreakEnabled CSS 类。
	 */
	clear(main: HTMLDivElement): void {
		for (const line of this.manualLineContainers) {
			// 将行容器内的子节点逐一移回 main（保持相对顺序）
			while (line.firstChild) {
				line.parentNode?.insertBefore(line.firstChild, line);
			}
			line.remove();
		}
		this.manualLineContainers = [];
		main.classList.remove(styles.manualLineBreakEnabled);
	}

	/**
	 * 在容器宽度变化超过 0.5px 时触发重排，避免每帧都重算。
	 * 通常由 ResizeObserver 回调驱动。
	 */
	maybeReflow(main: HTMLDivElement): void {
		if (this.layoutTokens.length === 0) return;
		const width = this.getMainContentWidth(main);
		if (width <= 0) return;
		if (Math.abs(width - this.lastMainWidth) > 0.5) {
			this.apply(main);
		}
	}

	/**
	 * 执行手动断行布局：
	 * 1. 先清除旧断行结构；
	 * 2. 测量所有 token 的像素宽度；
	 * 3. 用贪心算法确定最少行数；
	 * 4. 用 balanced 策略逐行确定断点（优先标点/空白，其次分词边界，最后任意位置）；
	 * 5. 将 token 分组包裹进 `.lyricManualLine` 容器并追加到 main。
	 */
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

		// 启用 nowrap 以阻止浏览器自行换行，改由本算法控制
		main.classList.add(styles.manualLineBreakEnabled);

		// 测量所有 token 的视觉宽度
		for (const token of this.layoutTokens) {
			token.width = this.measureNodeWidth(token.node, transformScale);
		}

		// 总宽度不超过容器，无需断行
		const totalWidth = this.layoutTokens.reduce((sum, t) => sum + t.width, 0);
		if (totalWidth <= maxWidth) {
			this.lastMainWidth = maxWidth;
			return;
		}

		// 贪心扫描：逐 token 累加，超出 maxWidth 时开新行，得到最少所需行数
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

		// 构建前缀宽度数组，方便 O(1) 计算任意区间的累计宽度
		const prefixWidths: number[] = [0];
		for (const token of this.layoutTokens) {
			prefixWidths.push(prefixWidths[prefixWidths.length - 1] + token.width);
		}

		const lineRanges: Array<[number, number]> = [];
		let lineStart = 0;
		const breakCount = desiredLines - 1;

		for (let lineIndex = 0; lineIndex < breakCount; lineIndex++) {
			const remainingBreaks = breakCount - lineIndex;
			// 保证后续每行至少有一个 token，所以当前行最远到 endLimit
			const endLimit = this.layoutTokens.length - remainingBreaks - 1;
			// 本行目标宽度：剩余总宽均摊到剩余行数（balanced 思想）
			const remainingWidth = totalWidth - prefixWidths[lineStart];
			const remainingLines = desiredLines - lineIndex;
			const targetWidth = remainingWidth / remainingLines;

			// 在不溢出 maxWidth 的前提下，找到当前行能容纳的最右 token 下标
			let rightMostFit = lineStart;
			for (let j = lineStart; j <= endLimit; j++) {
				const width = prefixWidths[j + 1] - prefixWidths[lineStart];
				if (width <= maxWidth) {
					rightMostFit = j;
				} else {
					break;
				}
			}

			// 在 [lineStart, rightMostFit] 内按优先级策略选出最佳断点
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

		// 剩余 token 作为最后一行
		if (lineStart <= this.layoutTokens.length - 1) {
			lineRanges.push([lineStart, this.layoutTokens.length - 1]);
		}

		// 将每行 token 包裹进独立的 div 容器并批量插入
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

	/** 获取 HTMLElement 的水平内边距之和（像素） */
	private getNodeHorizontalPadding(node: Node): number {
		if (!(node instanceof HTMLElement)) return 0;
		const style = getComputedStyle(node);
		const pl = Number.parseFloat(style.paddingLeft) || 0;
		const pr = Number.parseFloat(style.paddingRight) || 0;
		return pl + pr;
	}

	/**
	 * 获取主行 div 的内容区宽度（clientWidth 减去水平 padding）。
	 * 由于 clientWidth 不受 CSS transform 影响，此宽度为布局像素值。
	 */
	private getMainContentWidth(main: HTMLDivElement): number {
		if (main.clientWidth <= 0) return 0;
		const style = getComputedStyle(main);
		const pl = Number.parseFloat(style.paddingLeft) || 0;
		const pr = Number.parseFloat(style.paddingRight) || 0;
		const contentWidth = main.clientWidth - (pl + pr);
		return Math.max(0, contentWidth);
	}

	/**
	 * 获取主行 div 的 CSS transform 缩放比例（rectWidth / clientWidth）。
	 * 用于将 getBoundingClientRect 返回的物理像素宽度还原为布局像素。
	 */
	private getMainTransformScale(main: HTMLDivElement): number {
		const clientWidth = main.clientWidth;
		if (clientWidth <= 0) return 1;
		const rectWidth = main.getBoundingClientRect().width;
		if (rectWidth <= 0) return 1;
		return rectWidth / clientWidth;
	}

	/**
	 * 测量单个节点的视觉宽度（布局像素）：
	 * - HTMLElement：使用 getBoundingClientRect，但扣除水平 padding（动画容器等会撑大 rect）；
	 * - Text 节点：使用 Range.getBoundingClientRect 直接测量文本渲染宽度。
	 * transformScale 用于将物理像素还原为布局像素。
	 */
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

	/**
	 * 在候选断点范围 [start, end] 内，选出最接近 targetWidth 的断点。
	 */
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

		/**
		 * 验证在 breakAt 处断行后，剩余 token 能否在剩余 remainingLines-1 行内放下。
		 * 使用贪心扫描，复杂度 O(n)，避免选出会导致后续行溢出的断点。
		 */
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

		// 收集候选断点
		const preferred: number[] = [];
		for (let j = start; j <= end; j++) {
			if (this.layoutTokens[j].breakPriority >= 2) {
				preferred.push(j);
			}
		}

		// 在候选集中选出与 targetWidth 偏差最小的断点
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

		// 仅保证当前行不溢出，均匀 balanced 分配
		const allSafe: number[] = [];
		for (let j = start; j <= end; j++) {
			if (noOverflow(j)) allSafe.push(j);
            else break
		}
		if (allSafe.length > 0) return pick(allSafe);

		// 单个 token 超过 maxWidth，无法避免溢出，取最后一个位置强制截断
		return end;
	}
}
