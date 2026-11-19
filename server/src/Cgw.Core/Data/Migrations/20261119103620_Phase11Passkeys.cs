using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase11Passkeys : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "PasskeyChallenges",
                columns: table => new
                {
                    Hash = table.Column<byte[]>(type: "binary(32)", fixedLength: true, maxLength: 32, nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PasskeyChallenges", x => x.Hash);
                });

            migrationBuilder.CreateTable(
                name: "UserPasskeys",
                columns: table => new
                {
                    CredentialId = table.Column<byte[]>(type: "varbinary(1024)", maxLength: 1024, nullable: false),
                    UserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    LastUsedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    Data = table.Column<string>(type: "nvarchar(max)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserPasskeys", x => x.CredentialId)
                        .Annotation("SqlServer:Clustered", false);
                    table.ForeignKey(
                        name: "FK_UserPasskeys_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_PasskeyChallenges_ExpiresAt",
                table: "PasskeyChallenges",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_UserPasskeys_UserId",
                table: "UserPasskeys",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "PasskeyChallenges");

            migrationBuilder.DropTable(
                name: "UserPasskeys");
        }
    }
}
