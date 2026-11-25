using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase18Billing : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "PlanPriceId",
                table: "AiSettings",
                type: "varchar(64)",
                unicode: false,
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "BillingCheckouts",
                columns: table => new
                {
                    TransactionId = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    PlanId = table.Column<string>(type: "varchar(32)", unicode: false, maxLength: 32, nullable: false),
                    PriceId = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    UserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    SubscriptionId = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BillingCheckouts", x => x.TransactionId);
                });

            migrationBuilder.CreateTable(
                name: "BillingEvents",
                columns: table => new
                {
                    EventId = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    Type = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    OccurredAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    ReceivedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    AppliedToWorkspace = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    SubscriptionId = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: true),
                    Outcome = table.Column<string>(type: "varchar(16)", unicode: false, maxLength: 16, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BillingEvents", x => x.EventId);
                });

            migrationBuilder.CreateTable(
                name: "WorkspaceBilling",
                columns: table => new
                {
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CustomerId = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: true),
                    SubscriptionId = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: true),
                    Status = table.Column<string>(type: "varchar(16)", unicode: false, maxLength: 16, nullable: false),
                    PriceId = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: true),
                    PeriodEndsAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    ScheduledAction = table.Column<string>(type: "varchar(16)", unicode: false, maxLength: 16, nullable: true),
                    ScheduledAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    ProviderUpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    CheckedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkspaceBilling", x => x.WorkspaceId);
                });

            migrationBuilder.CreateIndex(
                name: "IX_BillingCheckouts_WorkspaceId_CreatedAt",
                table: "BillingCheckouts",
                columns: new[] { "WorkspaceId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_BillingEvents_ReceivedAt",
                table: "BillingEvents",
                column: "ReceivedAt");

            migrationBuilder.CreateIndex(
                name: "IX_WorkspaceBilling_SubscriptionId",
                table: "WorkspaceBilling",
                column: "SubscriptionId",
                unique: true,
                filter: "[SubscriptionId] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "BillingCheckouts");

            migrationBuilder.DropTable(
                name: "BillingEvents");

            migrationBuilder.DropTable(
                name: "WorkspaceBilling");

            migrationBuilder.DropColumn(
                name: "PlanPriceId",
                table: "AiSettings");
        }
    }
}
