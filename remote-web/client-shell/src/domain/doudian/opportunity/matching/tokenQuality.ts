const fixedGenericTokens = new Set([
  "新款",
  "家用",
  "专用",
  "套装",
  "女款",
  "男款",
  "儿童",
  "同款",
  "正品",
  "爆款",
  "热卖",
  "夏季",
  "冬季",
  "春秋"
]);

function tokenLength(token: string) {
  return Array.from(String(token || "")).length;
}

export interface TokenQuality {
  token: string;
  length: number;
  productDf: number;
  productDfRatio: number;
  clueDf: number;
  idfWeight: number;
  lengthWeight: number;
  finalWeight: number;
  isGeneric: boolean;
  isStrong: boolean;
}

export function createTokenQualityMap(args: {
  tokens: string[];
  tokenToClueIds: Record<string, string[]>;
  productDf: Map<string, number>;
  productCount: number;
  genericTokenDfRatio: number;
}) {
  const productCount = Math.max(1, args.productCount);
  const result = new Map<string, TokenQuality>();
  for (const token of args.tokens) {
    const productDf = Number(args.productDf.get(token) || 0);
    const productDfRatio = productDf / productCount;
    const clueDf = args.tokenToClueIds[token]?.length || 0;
    const length = tokenLength(token);
    const idfWeight = Math.log((productCount + 1) / (productDf + 1)) + 1;
    const lengthWeight = length >= 6 ? 1.3 : length >= 4 ? 1.15 : 1;
    const isGeneric = fixedGenericTokens.has(token) || productDfRatio >= args.genericTokenDfRatio || productDf >= 20;
    const isStrong = !isGeneric && (length >= 4 || productDfRatio <= 0.05);
    const finalWeight = Math.max(0.1, idfWeight * lengthWeight * (isGeneric ? 0.45 : 1));
    result.set(token, {
      token,
      length,
      productDf,
      productDfRatio,
      clueDf,
      idfWeight,
      lengthWeight,
      finalWeight,
      isGeneric,
      isStrong
    });
  }
  return result;
}
