use std::net::SocketAddr;

#[cfg(feature = "mock-tee")]
use noblepay_compliance::{server, ComplianceEngine};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let environment = std::env::var("COMPLIANCE_ENV")
        .map_err(|_| anyhow::anyhow!("COMPLIANCE_ENV is required"))?;
    let bind_addr = std::env::var("COMPLIANCE_BIND_ADDR")
        .map_err(|_| anyhow::anyhow!("COMPLIANCE_BIND_ADDR is required"))?
        .parse::<SocketAddr>()?;

    if environment != "test" {
        anyhow::bail!(
            "the bundled compliance binary is test-only; configure an audited external service for production"
        );
    }
    #[cfg(feature = "mock-tee")]
    {
        let engine = ComplianceEngine::new().await;
        return server::serve(engine, bind_addr).await;
    }

    #[cfg(not(feature = "mock-tee"))]
    {
        let _ = bind_addr;
        anyhow::bail!("test mode requires --features mock-tee");
    }
}
