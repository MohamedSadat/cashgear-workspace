using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase13Ai : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "Subscription",
                table: "AiUsage",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "EmbeddingsKeySource",
                table: "AiSettings",
                type: "varchar(16)",
                unicode: false,
                maxLength: 16,
                nullable: false,
                defaultValue: "own");

            migrationBuilder.AddColumn<string>(
                name: "KeySource",
                table: "AiSettings",
                type: "varchar(16)",
                unicode: false,
                maxLength: 16,
                nullable: false,
                defaultValue: "own");

            migrationBuilder.CreateTable(
                name: "AiReservations",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Kind = table.Column<string>(type: "varchar(16)", unicode: false, maxLength: 16, nullable: false),
                    Tokens = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiReservations", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AiReservations_WorkspaceId_Kind_ExpiresAt",
                table: "AiReservations",
                columns: new[] { "WorkspaceId", "Kind", "ExpiresAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AiReservations");

            migrationBuilder.DropColumn(
                name: "Subscription",
                table: "AiUsage");

            migrationBuilder.DropColumn(
                name: "EmbeddingsKeySource",
                table: "AiSettings");

            migrationBuilder.DropColumn(
                name: "KeySource",
                table: "AiSettings");
        }
    }
}
