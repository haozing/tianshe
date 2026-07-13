export function scoreAhoTokenMatch(args: {
  matchedTokenCount: number;
  clueTokenCount: number;
  matchedWeightRatio: number;
  strongMatchedTokenCount: number;
  fullClueNameMatched: boolean;
}) {
  const categoryScore = 25;
  const tokenCountScore = Math.min(30, (args.matchedTokenCount / Math.max(1, args.clueTokenCount)) * 30);
  const tokenWeightScore = Math.min(30, args.matchedWeightRatio * 30);
  const strongTokenScore = Math.min(10, args.strongMatchedTokenCount * 5);
  const fullNameBonus = args.fullClueNameMatched ? 10 : 0;
  const wordScore = Math.round(tokenCountScore + tokenWeightScore + strongTokenScore + fullNameBonus);
  return {
    categoryScore,
    wordScore,
    matchScore: Math.min(100, Math.round(categoryScore + wordScore))
  };
}
