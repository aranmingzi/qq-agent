@echo off
chcp 65001 >nul 2>&1
rem 英文文件名别名：某些解压工具会让中文文件名乱码，双击这个效果一样
call "%~dp0启动 QQagent.bat"
