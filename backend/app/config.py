"""Application configuration.

All settings come from environment variables (see .env.example). Startup fails
when security-critical settings are missing or unsafe in staging/production.
"""
from __future__ import annotations

from decimal import Decimal
from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "test", "staging", "production"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: Environment = "development"
    app_name: str = "AI Trading Command Center"
    log_level: str = "INFO"

    database_url: str = "postgresql+psycopg://tcc:tcc@localhost:5432/tcc"

    # Session secret signs nothing client-readable; sessions are server-side.
    # It is still required so production cannot start with a default.
    session_secret: SecretStr = SecretStr("")
    session_ttl_hours: int = 12
    cookie_secure: bool = True
    # Admin account created on first start if no users exist.
    admin_bootstrap_user: str = "admin"
    admin_bootstrap_password: SecretStr = SecretStr("")
    cors_origins: str = ""
    # Public self-registration creates read-only "viewer" accounts.
    allow_signup: bool = True
    signup_rate_limit_per_hour: int = 5

    # Token n8n uses to call backend service endpoints. Never sent to browsers.
    service_token: SecretStr = SecretStr("")

    # --- Trading mode -------------------------------------------------------
    # Live execution is not implemented to submit orders; this flag exists so
    # the code path can verify it is off. Any value other than false aborts
    # startup until the activation procedure in docs/LIVE_TRADING_GATES.md exists.
    live_trading_enabled: bool = False
    paper_starting_equity: Decimal = Decimal("10000")

    # --- Risk limits (hard ceilings) -----------------------------------------
    max_planned_risk_per_trade: Decimal = Decimal("0.03")
    default_risk_per_trade: Decimal = Decimal("0.01")
    max_daily_loss: Decimal = Decimal("0.05")
    max_portfolio_exposure: Decimal = Decimal("1.5")  # notional / equity
    max_correlated_risk: Decimal = Decimal("0.05")
    max_drawdown_halt: Decimal = Decimal("0.20")
    drawdown_risk_reduction_start: Decimal = Decimal("0.10")
    max_leverage: Decimal = Decimal("3")
    data_stale_after_seconds: int = 900

    # --- Market data ----------------------------------------------------------
    binance_spot_base_url: str = "https://data-api.binance.vision"
    binance_futures_base_url: str = "https://fapi.binance.com"
    coingecko_base_url: str = "https://api.coingecko.com/api/v3"
    coingecko_api_key: SecretStr = SecretStr("")
    fred_base_url: str = "https://api.stlouisfed.org/fred"
    fred_api_key: SecretStr = SecretStr("")
    defillama_base_url: str = "https://api.llama.fi"
    defillama_stablecoins_url: str = "https://stablecoins.llama.fi"
    alternative_me_url: str = "https://api.alternative.me"
    http_timeout_seconds: float = 10.0
    http_max_retries: int = 3
    watch_symbols: str = "BTCUSDT,ETHUSDT"
    # Exchange prefix for TradingView tickers pushed by n8n (e.g. BINANCE:BTCUSDT).
    tradingview_exchange: str = "BINANCE"

    # --- LLM ------------------------------------------------------------------
    llm_provider: Literal["anthropic", "none"] = "none"
    llm_api_key: SecretStr = SecretStr("")
    llm_base_url: str = "https://api.anthropic.com"
    llm_model: str = "claude-opus-4-7"
    llm_timeout_seconds: float = 60.0
    llm_max_tokens_per_call: int = 1500
    debate_max_rounds: int = 8
    debate_token_budget: int = 60000
    debate_cost_budget_usd: Decimal = Decimal("2.00")
    # Price per million tokens used for budget estimates; set to your contract.
    llm_input_cost_per_mtok: Decimal = Decimal("5")
    llm_output_cost_per_mtok: Decimal = Decimal("25")

    # --- Telegram -------------------------------------------------------------
    telegram_bot_token: SecretStr = SecretStr("")
    telegram_webhook_secret: SecretStr = SecretStr("")
    telegram_allowed_user_ids: str = ""
    telegram_rate_limit_per_minute: int = 20
    telegram_api_base: str = "https://api.telegram.org"

    # --- MEXC (read-only) -----------------------------------------------------
    mexc_api_key: SecretStr = SecretStr("")
    mexc_api_secret: SecretStr = SecretStr("")
    mexc_spot_base_url: str = "https://api.mexc.com"
    mexc_futures_base_url: str = "https://contract.mexc.com"

    # --- n8n ------------------------------------------------------------------
    n8n_base_url: str = "http://n8n:5678"
    n8n_api_key: SecretStr = SecretStr("")

    @field_validator("max_planned_risk_per_trade")
    @classmethod
    def _risk_ceiling(cls, v: Decimal) -> Decimal:
        # The 3% ceiling is a product requirement; config may lower it, never raise it.
        if v <= 0 or v > Decimal("0.03"):
            raise ValueError("MAX_PLANNED_RISK_PER_TRADE must be in (0, 0.03]")
        return v

    @model_validator(mode="after")
    def _safety(self) -> "Settings":
        if self.live_trading_enabled:
            raise ValueError(
                "LIVE_TRADING_ENABLED=true is refused: live execution is not authorized. "
                "See docs/LIVE_TRADING_GATES.md."
            )
        if self.default_risk_per_trade > self.max_planned_risk_per_trade:
            raise ValueError("DEFAULT_RISK_PER_TRADE exceeds MAX_PLANNED_RISK_PER_TRADE")
        if self.app_env in ("staging", "production"):
            missing = [
                name
                for name, val in (
                    ("SESSION_SECRET", self.session_secret),
                    ("SERVICE_TOKEN", self.service_token),
                )
                if len(val.get_secret_value()) < 32
            ]
            if missing:
                raise ValueError(f"Security-critical settings missing or shorter than 32 chars: {missing}")
            if not self.cookie_secure:
                raise ValueError("COOKIE_SECURE must be true outside development")
            if self.telegram_bot_token.get_secret_value() and not self.telegram_webhook_secret.get_secret_value():
                raise ValueError("TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_BOT_TOKEN is set")
        return self

    @property
    def symbols(self) -> list[str]:
        return [s.strip().upper() for s in self.watch_symbols.split(",") if s.strip()]

    @property
    def telegram_allowlist(self) -> set[int]:
        out: set[int] = set()
        for part in self.telegram_allowed_user_ids.split(","):
            part = part.strip()
            if part.lstrip("-").isdigit():
                out.add(int(part))
        return out

    @property
    def llm_enabled(self) -> bool:
        return self.llm_provider != "none" and bool(self.llm_api_key.get_secret_value())

    @property
    def mexc_configured(self) -> bool:
        return bool(self.mexc_api_key.get_secret_value() and self.mexc_api_secret.get_secret_value())


@lru_cache
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()


SECRET_FIELD_NAMES = {
    name for name, f in Settings.model_fields.items() if f.annotation is SecretStr
}
