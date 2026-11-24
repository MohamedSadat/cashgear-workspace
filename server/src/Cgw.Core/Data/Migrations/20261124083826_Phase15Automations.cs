using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase15Automations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "AutomationsOff",
                table: "Workspaces",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "TimeZone",
                table: "Workspaces",
                type: "varchar(64)",
                unicode: false,
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "AutomationId",
                table: "Notifications",
                type: "binary(16)",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Reason",
                table: "Notifications",
                type: "varchar(40)",
                unicode: false,
                maxLength: 40,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "EventRules",
                table: "Databases",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "AutomationEvents",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    DatabaseId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    RowId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Kind = table.Column<string>(type: "varchar(10)", unicode: false, maxLength: 10, nullable: false),
                    Changed = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Before = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    After = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    ActorId = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    Depth = table.Column<int>(type: "int", nullable: false),
                    RunId = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    PressId = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    TakenAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    DoneAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AutomationEvents", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "AutomationRuns",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    AutomationId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    DatabaseId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    RowId = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    EventId = table.Column<long>(type: "bigint", nullable: true),
                    DueKey = table.Column<string>(type: "varchar(120)", unicode: false, maxLength: 120, nullable: true),
                    Trigger = table.Column<string>(type: "varchar(20)", unicode: false, maxLength: 20, nullable: false),
                    Depth = table.Column<int>(type: "int", nullable: false),
                    ActorId = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    AuthorId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Status = table.Column<string>(type: "varchar(10)", unicode: false, maxLength: 10, nullable: false),
                    Reason = table.Column<string>(type: "varchar(40)", unicode: false, maxLength: 40, nullable: true),
                    Steps = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    StartedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    EndedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AutomationRuns", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Automations",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    DatabaseId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Definition = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    TriggerKind = table.Column<string>(type: "varchar(20)", unicode: false, maxLength: 20, nullable: false),
                    Enabled = table.Column<bool>(type: "bit", nullable: false),
                    AuthorId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Version = table.Column<long>(type: "bigint", nullable: false),
                    NextAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    ScannedUntil = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    DeletedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Automations", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "WebhookDeliveries",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WebhookId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    RunId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    StepIndex = table.Column<int>(type: "int", nullable: false),
                    Body = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Attempts = table.Column<int>(type: "int", nullable: false),
                    NextAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    Status = table.Column<string>(type: "varchar(10)", unicode: false, maxLength: 10, nullable: false),
                    LastStatus = table.Column<int>(type: "int", nullable: true),
                    LastError = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    DeliveredAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WebhookDeliveries", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Webhooks",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    Url = table.Column<string>(type: "nvarchar(2048)", maxLength: 2048, nullable: false),
                    SecretCipher = table.Column<string>(type: "varchar(4000)", unicode: false, maxLength: 4000, nullable: false),
                    CreatedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Webhooks", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AutomationEvents_CreatedAt",
                table: "AutomationEvents",
                column: "CreatedAt");

            migrationBuilder.CreateIndex(
                name: "IX_AutomationEvents_PressId",
                table: "AutomationEvents",
                column: "PressId",
                unique: true,
                filter: "[PressId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_AutomationEvents_Waiting",
                table: "AutomationEvents",
                column: "Id",
                filter: "[DoneAt] IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_AutomationRuns_AutomationId_DueKey",
                table: "AutomationRuns",
                columns: new[] { "AutomationId", "DueKey" },
                unique: true,
                filter: "[DueKey] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_AutomationRuns_AutomationId_EventId",
                table: "AutomationRuns",
                columns: new[] { "AutomationId", "EventId" },
                unique: true,
                filter: "[EventId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_AutomationRuns_AutomationId_StartedAt",
                table: "AutomationRuns",
                columns: new[] { "AutomationId", "StartedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_AutomationRuns_RowId_StartedAt",
                table: "AutomationRuns",
                columns: new[] { "RowId", "StartedAt" },
                filter: "[RowId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_AutomationRuns_Running",
                table: "AutomationRuns",
                column: "StartedAt",
                filter: "[Status] = 'running'");

            migrationBuilder.CreateIndex(
                name: "IX_AutomationRuns_WorkspaceId_StartedAt",
                table: "AutomationRuns",
                columns: new[] { "WorkspaceId", "StartedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Automations_DatabaseId_DeletedAt",
                table: "Automations",
                columns: new[] { "DatabaseId", "DeletedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Automations_Live",
                table: "Automations",
                columns: new[] { "TriggerKind", "WorkspaceId" },
                filter: "[DeletedAt] IS NULL AND [Enabled] = 1");

            migrationBuilder.CreateIndex(
                name: "IX_WebhookDeliveries_RunId_StepIndex",
                table: "WebhookDeliveries",
                columns: new[] { "RunId", "StepIndex" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WebhookDeliveries_Waiting",
                table: "WebhookDeliveries",
                column: "NextAt",
                filter: "[Status] = 'pending'");

            migrationBuilder.CreateIndex(
                name: "IX_WebhookDeliveries_WebhookId",
                table: "WebhookDeliveries",
                column: "WebhookId");

            migrationBuilder.CreateIndex(
                name: "IX_Webhooks_WorkspaceId",
                table: "Webhooks",
                column: "WorkspaceId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AutomationEvents");

            migrationBuilder.DropTable(
                name: "AutomationRuns");

            migrationBuilder.DropTable(
                name: "Automations");

            migrationBuilder.DropTable(
                name: "WebhookDeliveries");

            migrationBuilder.DropTable(
                name: "Webhooks");

            migrationBuilder.DropColumn(
                name: "AutomationsOff",
                table: "Workspaces");

            migrationBuilder.DropColumn(
                name: "TimeZone",
                table: "Workspaces");

            migrationBuilder.DropColumn(
                name: "AutomationId",
                table: "Notifications");

            migrationBuilder.DropColumn(
                name: "Reason",
                table: "Notifications");

            migrationBuilder.DropColumn(
                name: "EventRules",
                table: "Databases");
        }
    }
}
