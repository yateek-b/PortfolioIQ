import { Request, Response } from "express";
import { getPortfolioByClientId } from "../services/portfolioDb.service";
import { PortfolioBasicsService } from "../services/portfolioBasics.service";
import { portfolioInsightsService } from "../services/portfolioInsights.service";
import { RiskMetricsService } from "../services/riskMetrics.service";
import { MarketDataAPIService } from "../services/marketData-api.service";

const portfolioBasicsService = new PortfolioBasicsService();
const riskMetricsService = new RiskMetricsService();

function parseIncludeRisk(value: unknown): boolean {
  if (typeof value !== "string") {
    return true;
  }

  return value.toLowerCase() !== "false";
}

function toPlainPortfolio<T>(portfolio: T): T {
  if (
    typeof portfolio === "object" &&
    portfolio !== null &&
    "toObject" in portfolio &&
    typeof (portfolio as { toObject: () => T }).toObject === "function"
  ) {
    return (portfolio as { toObject: () => T }).toObject();
  }

  return portfolio;
}

export async function getPortfolioController(req: Request, res: Response) {
  try {
    const { clientId } = req.params;
    const includeRisk = parseIncludeRisk(req.query.includeRisk);

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: "clientId is required",
      });
    }

    const portfolioDocument = await getPortfolioByClientId(clientId);

    if (!portfolioDocument) {
      return res.status(404).json({
        success: false,
        error: "Portfolio not found",
      });
    }

    const portfolio = toPlainPortfolio(portfolioDocument);
    const holdings = portfolio.holdings ?? [];
    const weights = holdings.map((holding) => holding.weight);
    const sectorData = holdings.map((holding) => ({
      sector: holding.sector,
      weight: holding.weight,
    }));

    const derivedMetrics = {
      hhi: portfolioInsightsService.calculateHHI(weights),
      effective_assets: portfolioInsightsService.calculateEffectiveAssets(
        portfolioInsightsService.calculateHHI(weights)
      ),
      top_3_concentration:
        portfolioInsightsService.calculateTop3Concentration(weights),
      sector_exposure:
        portfolioInsightsService.calculateSectorExposure(sectorData),
      asset_count: portfolioInsightsService.calculateAssetCount(weights),
    };

    let riskMetrics: Record<string, unknown> = {};

    if (includeRisk) {
      const marketDataService = new MarketDataAPIService();
      const symbols = holdings.map((holding) => holding.asset_id);
      const priceMap = await marketDataService.getMultiplePrices(symbols);
      const historicalReturns = symbols.map((symbol) =>
        marketDataService.calculateReturns(priceMap[symbol] ?? [])
      );
      const alignedLength = historicalReturns.reduce((minLength, returns) => {
        if (returns.length === 0) {
          return minLength;
        }

        return Math.min(minLength, returns.length);
      }, Number.POSITIVE_INFINITY);

      const normalizedReturns =
        alignedLength === Number.POSITIVE_INFINITY
          ? []
          : historicalReturns.map((returns) => returns.slice(-alignedLength));

      const portfolioReturns =
        normalizedReturns.length > 0 && alignedLength > 0
          ? portfolioBasicsService.calculatePortfolioReturns(
              normalizedReturns,
              weights
            )
          : [];

      const indexPrices = await marketDataService.getIndexPrices("SPY");
      const indexReturns = marketDataService
        .calculateReturns(indexPrices.values)
        .slice(-portfolioReturns.length);

      const volatility = riskMetricsService.calculateVolatility(
        portfolioReturns
      );
      const beta = riskMetricsService.calculateBeta(
        portfolioReturns,
        indexReturns
      );
      const maxDrawdown = riskMetricsService.calculateMaxDrawdown(
        portfolioReturns
      );
      const varAmount = riskMetricsService.calculateVaR(
        portfolioReturns,
        portfolio.portfolio_value
      );
      const var95 =
        portfolio.portfolio_value === 0
          ? 0
          : varAmount / portfolio.portfolio_value;

      riskMetrics = {
        volatility,
        beta,
        max_drawdown: maxDrawdown,
        var_95: varAmount,
        risk_level: portfolioInsightsService.calculateRiskLevel(
          volatility,
          var95,
          maxDrawdown
        ),
        risk_score: portfolioInsightsService.calculateRiskScore(
          volatility,
          var95
        ),
        key_risk_drivers: portfolioInsightsService.getRiskDrivers(
          derivedMetrics.sector_exposure,
          volatility,
          beta,
          derivedMetrics.top_3_concentration
        ),
      };
    }

    return res.json({
      success: true,
      data: {
        portfolio,
        derived_metrics: derivedMetrics,
        risk_metrics: riskMetrics,
      },
    });
  } catch (error) {
    console.error("Error fetching portfolio:", error);

    const message = error instanceof Error ? error.message : "Internal server error";

    return res.status(500).json({
      success: false,
      error: message,
    });
  }
}